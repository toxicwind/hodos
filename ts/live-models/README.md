# @flock/live-models

Live model discovery scheduler, ported from estate-scripts-router's
`router_live_models.ts`. A thin scheduler around the **Roost package**
(`../roost/src`): for every provider with a configured key, run Roost's
adapter-aware `discover()` (OpenAI / Google v1beta / Mistral / static /
none shapes), feed the result into the unified `ModelCatalog` (which owns
serving membership, quarantine, and persistence), and keep router-side live
metadata (pricing, context length...) that `/v1/models` and the strategy
tier's `modelFree` consume.

## State

- `provider-catalog.json` — Roost-owned (quarantine, miss streaks,
  everDiscovered). Written atomically by the catalog itself.
- `live-models.json` (`/home/toxic/estate/.state/live-models.json`) —
  scheduler-owned `{ fetchedAt, meta }` (per-model live metadata). On
  upgrade from the old shape, a legacy `{ models }` map is folded into the
  catalog once via Roost's v1 migration path so the warm cache survives.

`slimMeta()` drops the long prose `description` from discovered metadata —
it bloats the persisted state and the `/v1/models` payload without helping
routing. Everything else (pricing, context_length, architecture,
limits...) is kept.

## Event-driven, no timers

Refresh triggers:

- `startLiveDiscovery()` — startup (non-blocking: serve from seeds +
  persisted state immediately, refresh in the background)
- `SIGHUP` — explicit operator signal to re-discover
- `POST /admin/reload` — calls `refreshLiveModels()` directly
- request-triggered — call `refreshLiveModels()` when a request observes
  stale data

Concurrent triggers share one in-flight run (**singleflight**) — no
duplicate discovery sweeps.

## API

`startLiveDiscovery(deps)`, `refreshLiveModels(deps)`, `slimMeta(raw)`,
`LIVE_STATUS` (per-provider `{ ok, count, fetchedAt, error? }`),
`LIVE_MODEL_META` (provider → model id → slim metadata).

`LiveDiscoveryDeps` carries the catalog, `keyOk`, optional
`catalogStatePath` (atomically persisted after each sweep), and an
overridable `metaStatePath` for tests.

Tests: `bun test ./live-models.test.ts`
