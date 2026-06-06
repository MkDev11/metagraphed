import path from "node:path";
import { buildTimestamp, loadCandidates, repoRoot, stableStringify, writeJson } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const candidates = await loadCandidates();
const startedAt = new Date().toISOString();
const results = await mapLimit(candidates, 16, verifyCandidate);
const finishedAt = new Date().toISOString();

const artifact = {
  schema_version: 1,
  generated_at: buildTimestamp(),
  verification_started_at: startedAt,
  verification_finished_at: finishedAt,
  candidate_count: candidates.length,
  summary: {
    by_classification: countBy(results, "classification"),
    by_kind: countBy(results, "kind"),
    by_provider: countBy(results, "provider"),
    promotable_count: results.filter((result) => isPromotable(result)).length
  },
  results
};

if (!dryRun) {
  await writeJson(path.join(repoRoot, "registry/verification/latest.json"), artifact);
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    candidate_count: artifact.candidate_count,
    summary: artifact.summary
  })
);

async function verifyCandidate(candidate) {
  const base = {
    candidate_id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    netuid: candidate.netuid,
    provider: candidate.provider,
    source_tier: candidate.source_tier || null,
    source_type: candidate.source_type || null,
    source_url: candidate.source_url,
    source_urls: candidate.source_urls || [candidate.source_url],
    url: candidate.url,
    verified_at: new Date().toISOString()
  };

  if (!candidate.public_safe || isUnsafeUrl(candidate.url)) {
    return {
      ...base,
      classification: "unsafe",
      status: "failed",
      error: "candidate is not public-safe"
    };
  }

  const githubRepo = candidate.kind === "source-repo" ? parseGithubRepo(candidate.url) : null;
  if (githubRepo) {
    return verifyGithubRepo(base, githubRepo);
  }

  return verifyHttpSurface(base, candidate);
}

async function verifyGithubRepo(base, repo) {
  const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
  const api = await fetchJson(apiUrl, githubHeaders());
  if (api.ok) {
    const metadata = api.body;
    return {
      ...base,
      archived: Boolean(metadata.archived),
      classification: metadata.archived ? "unsupported" : "live",
      default_branch: metadata.default_branch || null,
      description: metadata.description || null,
      github_api_url: apiUrl,
      homepage: normalizeNullableUrl(metadata.homepage),
      html_url: metadata.html_url || base.url,
      last_push_at: metadata.pushed_at || null,
      status: metadata.archived ? "failed" : "ok",
      topics: Array.isArray(metadata.topics) ? metadata.topics.slice().sort() : []
    };
  }

  const fallback = await probeUrl(base.url, "HEAD", "text/html,application/xhtml+xml");
  return {
    ...base,
    classification: classifyHttpProbe(fallback),
    error: api.error || fallback.error || null,
    github_api_url: apiUrl,
    github_api_status: api.status_code || null,
    latency_ms: fallback.latency_ms,
    method_tested: fallback.method_tested,
    redirect_target: fallback.redirect_target,
    status: fallback.ok ? "ok" : "failed",
    status_code: fallback.status_code || null
  };
}

async function verifyHttpSurface(base, candidate) {
  const accept = acceptHeader(candidate.kind);
  let probe = await probeUrl(candidate.url, "HEAD", accept);
  if (!probe.ok || [400, 403, 405].includes(probe.status_code)) {
    probe = await probeUrl(candidate.url, "GET", accept);
  }

  return {
    ...base,
    classification: classifyHttpProbe(probe),
    content_type: probe.content_type || null,
    error: probe.error || null,
    latency_ms: probe.latency_ms,
    method_tested: probe.method_tested,
    redirect_target: probe.redirect_target,
    status: probe.ok ? "ok" : "failed",
    status_code: probe.status_code || null
  };
}

async function probeUrl(url, method, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept,
        "user-agent": "metagraphed-candidate-verifier/0.0"
      },
      redirect: "follow",
      signal: controller.signal
    });
    const latencyMs = Math.round(performance.now() - started);
    const redirectTarget = response.redirected && response.url !== url ? response.url : null;
    await response.body?.cancel();
    return {
      ok: response.ok,
      content_type: response.headers.get("content-type") || null,
      latency_ms: latencyMs,
      method_tested: method,
      redirect_target: redirectTarget,
      status_code: response.status
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      error_class: error.name,
      latency_ms: Math.round(performance.now() - started),
      method_tested: method
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "metagraphed-candidate-verifier/0.0",
        ...headers
      },
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      body: text ? JSON.parse(text) : null,
      status_code: response.status
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttpProbe(probe) {
  if (probe.redirect_target && probe.status_code >= 200 && probe.status_code < 400) {
    return "redirected";
  }
  if (probe.status_code >= 200 && probe.status_code < 400) {
    return "live";
  }
  if ([401, 403].includes(probe.status_code)) {
    return "auth-required";
  }
  if ([404, 410].includes(probe.status_code)) {
    return "dead";
  }
  return "unsupported";
}

function isPromotable(result) {
  return ["live", "redirected"].includes(result.classification);
}

function acceptHeader(kind) {
  switch (kind) {
    case "openapi":
      return "application/json,text/html;q=0.8,*/*;q=0.5";
    case "subnet-api":
      return "application/json,*/*;q=0.5";
    case "sse":
      return "text/event-stream";
    case "docs":
    case "dashboard":
    case "source-repo":
    case "website":
      return "text/html,application/xhtml+xml,*/*;q=0.5";
    default:
      return "*/*";
  }
}

function parseGithubRepo(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") {
      return null;
    }
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) {
      return null;
    }
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

function githubHeaders() {
  if (!process.env.GITHUB_TOKEN) {
    return {};
  }
  return {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "x-github-api-version": "2022-11-28"
  };
}

function isUnsafeUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return true;
    }
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "127.0.0.1" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    );
  } catch {
    return true;
  }
}

function normalizeNullableUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, mapper) {
  const queue = [...items];
  const results = [];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      results.push(await mapper(item));
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.netuid - b.netuid || a.candidate_id.localeCompare(b.candidate_id));
}

function countBy(items, key) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        accumulator[item[key]] = (accumulator[item[key]] || 0) + 1;
        return accumulator;
      }, {})
    ).sort(([a], [b]) => a.localeCompare(b))
  );
}
