# Flock merge gaps — endpoints the Rust proxy does not serve yet

The TS reference router (`estate-scripts-router-ts/router.ts`) exposes several
operational endpoints that the Rust proxy (`flock/`) does not implement.
These are SPECS for whoever wires the proxy (or the TS shim behind it) —
not code. Each section gives the contract the reference implementation
established, so the proxy's behavior matches what herd, the fleet, and the
dashboard already expect.

All admin/operator endpoints sit behind the same auth as the reference:
client-key gate when `estate-scripts_CLIENT_KEYS` is set (everything except
`/health` requires a key), and the operator-surface gate when AUTH users
are configured (`WWW-Authenticate: Bearer` on 401). `/health` stays open
for liveness probes.

## POST /admin/reload

Hot-reload without a restart.

Reference behavior (`router.ts` `hotReload(source)`):

1. Re-source secret files (`SECRET_FILES`, e.g. `~/.secrets`) into the
   environment.
2. Recompute key presence per provider → `keys: { <provider>: "configured" | "no_key" }`.
3. Kick a background `refreshLiveModels()` (singleflight dedupes against
   any in-flight sweep — see `ts/live-models/`).
4. Re-apply bench priors into Elo (`state.applyBenchPriors()` → policy
   tier equivalent).
5. Respond `200 { status: "ok", reloaded: { source: "http", keys, priors } }`
   and log the reload.

`SIGHUP` to the router process must trigger the same path (`source:
"SIGHUP"`). The TS `startLiveDiscovery()` in `ts/live-models/` already
installs the SIGHUP handler for the discovery half; the proxy's SIGHUP
must additionally cover steps 1 and 4.

## POST /admin/catalog/serve-404

404 event intake for non-TS consumers (Go herd). The catalog is the brain:
a serve-time 404 quarantines the id immediately, and the live export is
rewritten so herd picks it up from the file. Herd reports the event; the
quarantine decision lives here, once.

- Request: JSON `{ provider: string, model: string }`. Both required —
  missing/blank → `400 { error: "provider and model required" }`.
  Invalid JSON → `400 { error: "invalid json" }`.
- Effect: `circuit.noteEntitlement404(provider, model)` — LOUD permanent
  bench for the delisted/unentitled id (policy tier, `ts/policy/`).
- Response: `200 { status: "ok", provider, model, quarantined: true }`.

## GET /debug/sqlite

Returns `state.health.debugAgg()` — the raw aggregate rollups from the
policy health DB (`ts/policy/` `PolicyHealthDB`): per-provider request
counts, error breakdowns, latency aggregates. On failure:
`500 { error: <message> }`. Operator-gated.

## GET /debug/health

- `summary`: `state.health.getProviderSummary()` — per-provider health
  rollup from the policy DB.
- `healing`: `{ <provider>: state.health.recentHealing(<provider>) }` for
  every provider — recent recovery/window signals the circuit layer uses
  to half-open lanes.
- Operator-gated.

## /mesh

`handleMeshRequest(req, { service: "estate-scripts-router", version: "v3.2" })`
from the mesh features lib — the standard mesh control plane (peer
discovery, gossip, task routing). The proxy must mount the mesh handler at
`/mesh*` with the service name updated to the proxy's own
(`"flock"` / whatever the proxy advertises). Routed BEFORE the
client-key gate (mesh traffic carries its own auth).

## GET /openfang/resolve

openfang `agent set` parsing shim (router-side; the fork itself is
track-4 domain). Normalizes any spec the buggy CLI can produce —
`"nvidia:gpt-oss-20b"`, `"provider/model"`, bare ids, aliases — into the
canonical triple the daemon should use.

- Query: `?spec=<raw spec>`.
- Response `200`:
  - `spec`: the raw input
  - `provider`, `model`: resolved via `resolveModel(spec)` (strategy
    tier, `ts/strategy/`)
  - `provider_base_url`: the provider's base URL from the Roost defs
    (null when unknown)
  - `router_chat_url`: `http://127.0.0.1:<PORT>/v1/chat/completions`
  - `router_status_url`: `http://127.0.0.1:<PORT>/status`
  - `normalized_from`: `"<provider>:<model>"` when the spec pinned a
    provider, else the normalized model
  - `note`: guidance text — point the daemon at the router
    (OpenAI-compatible): set the agent provider `base_url` to
    `router_chat_url`, or use `provider_base_url` with the returned model.
    The router itself accepts the raw spec; the mangled
    `provider:model` form is normalized here, not in the fork.

## /ui and /ui/data

- `GET /ui` (and `/ui/`) → `200 text/html` serving the dashboard HTML.
  The TS package ships `FLOCK_UI_HTML` in `ts/strategy/ui-data.ts`
  (ported from `router_ui.ts`, retitled "Flock", cascade strategy added).
  The primary dashboard remains the Bun app at `flock/dashboard`; `/ui`
  is the lightweight fallback the reference router served.
- `GET /ui/data` → `200 JSON` from `uiData(deps)` (same module):
  strategy name, strategy list, per-provider keys/elo/circuit/models/live
  counts/live_status/health summary, recent strategy counts, catalog
  summary. Contract kept identical to the reference so any existing
  dashboard consumer keeps working.

## Deliberately not ported

- `/metrics` (Prometheus) — the Rust proxy serves its own.
- `/auth/login`, `/auth/logout` — covered by the proxy's auth.rs port.
- `GET /v1/models` — the proxy's catalog endpoint; the TS `live-models`
  package feeds it the same `LIVE_MODEL_META` the reference used.
