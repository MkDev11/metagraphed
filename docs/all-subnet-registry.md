# All-Subnet Registry Model

Metagraphed covers every active Finney subnet through chain-native data plus curated public-interface overlays.

## Native Snapshot

`registry/native/finney-subnets.json` is generated from decoded Bittensor SDK data.

It is canonical for:

- active netuid existence;
- root/system versus application subnet classification;
- chain subnet name and symbol;
- participant count;
- tempo;
- registration block;
- mechanism count;
- capture block and source metadata.

It is not the place for docs URLs, dashboards, public APIs, or probe rules.

## Curated Overlays

`registry/subnets/*.json` and `registry/subnets/generated/*.json` contain curated interface metadata.

Overlays are canonical for:

- public APIs;
- OpenAPI/Swagger surfaces;
- SSE/event streams;
- dashboards;
- docs;
- repositories;
- data artifacts;
- read-only probe rules.

An overlay must reference a netuid that exists in the native snapshot unless it is explicitly marked pending.

Curation levels:

- `native`: chain-derived only;
- `candidate-discovered`: public candidates exist but are not verified;
- `machine-verified`: safe public probes verified promoted surfaces;
- `maintainer-reviewed`: a human reviewed the overlay;
- `adapter-backed`: subnet-specific public data dimensions are modeled.

## Candidate Queue

`registry/candidates` is for unverified public interface candidates from community submissions or third-party discovery.

Candidates are never treated as verified surfaces. They must pass maintainer review before being promoted into `registry/subnets`.

`npm run discover:candidates` generates a public-source candidate bundle from enrichment sources such as TaoMarketCap, Tensorplex subnet-docs, and Taopedia articles. Generated candidates are review inputs only.

`npm run verify:candidates` writes `registry/verification/latest.json` with live, redirected, auth-required, dead, unsafe, or unsupported classifications.

`npm run curate:baseline` promotes only live/redirected public-safe candidates into generated baseline overlays. It does not overwrite hand-curated overlays.

## Generated Artifacts

`public/metagraph/subnets.json` lists every active chain subnet.

`public/metagraph/surfaces.json` lists only curated/verified public interface surfaces.

`public/metagraph/coverage.json` summarizes chain coverage, curated overlays, native-only stubs, probed subnets, and candidate counts.

`public/metagraph/candidates.json` lists unverified candidate surfaces with source provenance.

`public/metagraph/review-queue.json` lists candidate surfaces that need maintainer review.

`public/metagraph/curation.json` lists curation level, review state, source count, and gaps for every active subnet.

`public/metagraph/gaps.json` lists missing docs/repo/site/dashboard/API/OpenAPI/SSE/data-artifact facets by subnet.

`public/metagraph/verification/latest.json` exposes the latest candidate verification snapshot.

`public/metagraph/subnets/{netuid}.json` exposes per-subnet static detail artifacts for app and API consumers.
