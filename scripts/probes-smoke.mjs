import path from "node:path";
import { buildTimestamp, flattenSurfaces, loadSubnets, repoRoot, writeJson } from "./lib.mjs";

const subnets = await loadSubnets();
const surfaces = flattenSurfaces(subnets).filter((surface) => surface.probe?.enabled && surface.public_safe);
const startedAt = Date.now();

async function probeSurface(surface) {
  const timeoutMs = surface.probe.timeout_ms || 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(surface.url, {
      method: surface.probe.method,
      headers: {
        accept: acceptHeader(surface.probe.expect),
        "user-agent": "metagraphed-smoke-probe/0.0"
      },
      signal: controller.signal
    });

    const latencyMs = Math.round(performance.now() - started);
    const contentType = response.headers.get("content-type") || "";
    const status = response.ok ? "ok" : "failed";
    await response.body?.cancel();

    return {
      auth_required: surface.auth_required,
      content_type: contentType || null,
      kind: surface.kind,
      latency_ms: latencyMs,
      method_tested: surface.probe.method,
      provider: surface.provider,
      status,
      status_code: response.status,
      subnet_name: surface.subnet_name,
      subnet_slug: surface.subnet_slug,
      surface_id: surface.id,
      url: surface.url,
      verified_at: new Date().toISOString()
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    return {
      auth_required: surface.auth_required,
      error: error.message,
      error_class: error.name,
      kind: surface.kind,
      latency_ms: latencyMs,
      method_tested: surface.probe.method,
      provider: surface.provider,
      status: "failed",
      subnet_name: surface.subnet_name,
      subnet_slug: surface.subnet_slug,
      surface_id: surface.id,
      url: surface.url,
      verified_at: new Date().toISOString()
    };
  } finally {
    clearTimeout(timer);
  }
}

function acceptHeader(expect) {
  switch (expect) {
    case "json":
      return "application/json";
    case "html":
      return "text/html,application/xhtml+xml";
    case "sse":
      return "text/event-stream";
    default:
      return "*/*";
  }
}

const results = await mapLimit(surfaces, 16, probeSurface);

const artifact = {
  schema_version: 1,
  generated_at: buildTimestamp(),
  probe_started_at: new Date(startedAt).toISOString(),
  probe_finished_at: new Date().toISOString(),
  source: "live-smoke-probe",
  surfaces: results
};

if (process.env.METAGRAPH_WRITE_PROBE_RESULTS === "1") {
  const outputRoot = path.join(repoRoot, "public/metagraph");
  await writeJson(path.join(outputRoot, "health/latest.json"), artifact);
  const day = artifact.probe_finished_at.slice(0, 10);
  await writeJson(path.join(outputRoot, `health/history/${day}.json`), artifact);
}

const ok = results.filter((result) => result.status === "ok").length;
const failed = results.length - ok;
console.log(`Smoke-probed ${results.length} surface(s): ${ok} ok, ${failed} failed.`);

for (const result of results) {
  const latency = result.latency_ms === undefined ? "" : ` ${result.latency_ms}ms`;
  const code = result.status_code === undefined ? "" : ` HTTP ${result.status_code}`;
  console.log(`${result.status.padEnd(6)} ${result.surface_id}${code}${latency}`);
}

if (failed > 0 && process.env.METAGRAPH_STRICT_PROBES === "1") {
  process.exit(1);
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
  return results.sort((a, b) => a.subnet_slug.localeCompare(b.subnet_slug) || a.surface_id.localeCompare(b.surface_id));
}
