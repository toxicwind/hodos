# flock/ts/policy — estate-scripts-router policy engine (TypeScript)

Port of the estate-scripts-router policy layer (`estate-scripts/tools/estate-scripts-router/estate-scripts-router-ts/`)
into Flock as the **policy tier**. Bun/TypeScript throughout.

## The boundary (read before touching)

The Rust proxy (`mesh/proxy/flock-proxy/src/`) owns the **hot path** — per-request decisions at
microsecond scale. This package owns the **policy math** — things that change on
human timescales. They complement; they do not duplicate:

| Concern | Rust proxy | This package |
|---|---|---|
| Circuit breaking (per-request) | `circuit.rs` — AstMatrix semantics: 5 failures, fixed 30s timeout, 2 half-open successes | `circuit.ts` — **quarantine policy**: failure-class counting (401/402 = 3x), exponential-backoff levels, active re-probing, `laneDead` race exclusion, entitlement-404 bench, flap tracker |
| Elo | `health.rs` — persisted Elo **store** (`get_elo`/`set_elo`, SQLite) | `elo.ts` — **rating math**: outcome → updates (+16/−32/−8), latency EMA (α=0.2), `candidateScore`, bench-prior seeding with persisted-protection |
| Bench priors | — (not loaded) | `bench-priors.json` + `loadBenchPriors` / `EloEngine.applyBenchPriors` |
| Warm standby | pool/proxy keep-alive hints only | `warm-standby.ts` — 30s local-lane pinger with **keyed-provider auth** (`keyEnv` → `Authorization: Bearer`) |
| Health | `health.rs` — live provider state (healthy/latency/sticky), write-behind | `health.ts` — **request analytics**: 5-min aggregate windows, 30-min summaries, p50/p95, healing-event feed, sticky affinity, `elo_state` (implements `EloStore` for `elo.ts`) |
| Model pressure | `governor.rs` — AIMD concurrency governor | — (not ported; Rust owns it) |

## Wiring

```ts
import { EloEngine, loadBenchPriors, CircuitPolicy, WarmStandby, PolicyHealthDB } from "./index.ts";

// 1. Health analytics DB (SQLite WAL). elo_state doubles as the Elo store.
const health = new PolicyHealthDB("/home/toxic/estate/data/flock_policy.db");

// 2. Elo engine, writing through to the DB.
const elo = new EloEngine(health.asEloStore());
const { priors, source, mtime } = loadBenchPriors(`${import.meta.dir}/bench-priors.json`);
elo.applyBenchPriors(PROVIDER_NAMES, priors, mtime, source, /*force=*/ true);

// 3. Quarantine policy, healing feed → the DB.
const circuit = new CircuitPolicy({
  onHealing: (e) => health.recordHealing(e.provider, e.model, e.event, e.prev, e.next, e.details ?? ""),
});

// 4. Warm standby for local lanes → probe-only circuit updates (no Elo inflation).
const warm = new WarmStandby(
  [
    { name: "herd", base: "http://127.0.0.1:25100/v1" },
    { name: "nim-local", base: "http://127.0.0.1:8000/v1", keyEnv: "NIM_PROXY_API_KEY" },
  ],
  { onProbe: (p, ok, err) => circuit.recordProbe(p, ok, err) },
);
warm.start();

// Per request:
circuit.register("nvidia");
if (circuit.circuitOk("nvidia") && !circuit.laneDead("nvidia") && !circuit.isEntitlementDead("nvidia", model)) {
  // ... attempt ...
  circuit.recordOutcome("nvidia", model, status);   // strikes + circuit
  elo.recordOutcome("nvidia", status, latencyMs);    // rating + latency EMA
  health.recordRequest("nvidia", model, status, latencyMs, strategy, winner, sessionId);
}
// Candidate ordering:
const score = elo.candidateScore("nvidia"); // elo − emaMs/50
```

Hot-reload bench priors without clobbering learned values (SIGHUP / /admin/reload):

```ts
const { priors, source, mtime } = loadBenchPriors(PRIORS_PATH);
elo.applyBenchPriors(PROVIDER_NAMES, priors, mtime, source); // force=false: only untouched providers re-seed
```

## Outcome semantics (the parts that bite)

- **401/402** (dead key): counts **3x** toward the circuit threshold — the provider is
  dead, open the circuit and exclude the lane after a single attempt.
- **404** (model): benches the **model id** for the process lifetime (zero retry burn);
  the provider keeps serving its healthy models. Re-admitted when the catalog re-lists it.
- **429**: Elo −8, counted for `laneDead`, but **never opens the circuit** (throttled ≠ dead).
- **Probe outcomes** (`recordProbe`): move strikes/circuits only — Elo and request
  analytics are never touched by synthetic traffic.
- **Bench priors** seed Elo in memory only at startup; only live outcomes create
  durable rows. Hot-reload never re-seeds a provider with a persisted/live-learned value —
  numeric equality with the prior is not proof it is untouched.

## Tests

```sh
bun test
```
