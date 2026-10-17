# Flock ← Roost integration design (Phase 2)

**Status:** design + Roost-side codegen LANDED; flock serving-path changes PROPOSED (needs review).
**Date:** 2026-09-30 · **Lane:** flock-roost-phase2 · **Author:** forge (Ember's crew)
**Decision target:** Roost is the sole provider catalog (52 providers). Flock's
Rust proxy (`:25193`) must consume Roost-derived wire data instead of its
hand-maintained duplicate registry.

---

## 1. Findings (observed, not narrated)

### 1.1 The live flock registry comes from `default_providers()` on every boot

- `/home/toxic/.flock-data/config.json` is **version 1** with **no `providers`
  field** (verified 2026-09-30 via `jq`: `version: 1`, `providers_type: "null"`).
- `config.rs::load()` therefore runs `migrate_v1()` on **every boot**,
  building the registry in memory as `[nvidia-from-upstream] +
  default_providers().filter(name != "nvidia")`.
- Conclusion: `proxy/src/providers.rs::default_providers()` — the 13
  hardcoded provider defs — **is effectively on the live serving path**.
  Changing it changes what flock advertises and routes after the next
  restart, even though `config.json` is the nominal authority.

### 1.2 How the stale model catalog is advertised

`proxy.rs::aggregate_models()` builds `/v1/models` as:

1. the **live** nvidia upstream listing (authoritative, fetched per request),
2. **plus every other provider's static `def.models`** — the hand-curated
   lists seeded from `default_providers()`.

`router.rs` already runs a probe loop that refreshes each *usable* provider's
`/v1/models` into a per-runtime `models_cache` — but `aggregate_models`
**ignores that cache** and merges the static lists. So the advertised catalog
is frozen at whatever was hand-written in `providers.rs`, while live
discovery data sits unused for advertisement. This is the stale-IDs surface
(herd config showed flock advertising ~103 IDs with mass upstream 404s).

Note: `provider_metadata()` tags each merged entry with `usable` (keys
present) — keyless providers' static IDs are advertised anyway.

### 1.3 Deploy mechanics

- Live binary is **prebuilt**: `/home/toxic/.flock/flock` (2026-09-29 20:04).
- Launcher: `flock/bin/flock-run.sh` injects `GROQ/CEREBRAS/NVIDIA` keys from
  `/home/toxic/.secrets`, sets `DATA_DIR=/home/toxic/.flock-data`, execs the
  binary. Pitchfork supervises it (`[daemons.flock]`, `:25193`).
- Any source change needs: `cargo build --release` on yote → deploy binary
  (keep a backup) → restart via the owned pitchfork flow (never kill+start in
  one remote command) → verify `/health`, `/v1/models`, real completion,
  restart durability.

### 1.4 Roost ↔ flock provider overlap

All 13 of flock's providers exist in Roost's 52 (verified by name):
`herd, openrouter, nvidia, groq, together, cerebras, fireworks,
hyperbolic, github, mistral, openai, perplexity, siliconflow`.
The three flock-originated providers (**hyperbolic, github, perplexity**)
are present with matching base URLs and seeds — no special-casing needed.

Staleness character: **none** of flock's current static seeds appear in
`ROOST_DEAD_IDS` — the rot is frozen old curation (e.g. 2 nvidia seeds vs
Roost's 12 current ones), not known-dead IDs. The win is freshness + a single
source of truth, with `ROOST_DEAD_IDS` as the permanent EOL guard.
(Correction to an earlier fleet note: bare `openai/gpt-oss-20b` is NOT in
deadIds — only the `:free` form was delisted. The 4 Groq 404-verified IDs
are `llama-3.3-70b-versatile`, `qwen/qwen3-32b`, `qwen/qwen3.6-27b`,
`meta-llama/llama-4-scout-17b-16e-instruct`.)

### 1.5 What flock owns (stays hand-written)

Roost's `ProviderDef` has no flock-operational fields. These stay in flock:
`Strategy`, `RoutingCfg` (max_parallel, max_retries, sticky_ttl, fifo_max,
coalescing, probe_interval), per-key `rpm`/`owner`/`enabled`, `free_tier`,
`model_map`, `weight`, `elo`, `default_rpm`, `display_name` tuning,
`ProviderSet` candidate indexing, lane specs, circuit/health/governor logic.

---

## 2. What landed in this lane (Roost side — committed)

`roost/src/codegen.ts` gains **`buildProvidersRust()`**, following the exact
pattern of the existing Go codegen for herd:

- `roost/generated/providers.rs` — checked-in generated Rust module:
  - `ROOST_PROVENANCE: &str`
  - `RoostProvider` struct — `name, display_name, base_url, key_env,
    key_env_alt, adapter, auth, header_name, query_param, models_path,
    router_local, enabled, seeds, static_models` (all `&'static str` /
    `&'static [&'static str]` / `bool` — zero-cost, no serde needed)
  - `ROOST_PROVIDERS: &[RoostProvider]` (52 entries)
  - `ROOST_DEAD_IDS: &[&str]` (sorted)
  - `ROOST_ALIASES: &[(&str, &str, &str)]` (sorted)
- Seeds are emitted **raw** (may name dead IDs); the consumer filters
  `ROOST_DEAD_IDS` — same contract as the Go artifact.
- `emitAll()` now writes all three artifacts; `scripts/build.ts` logs the
  third path; `src/index.ts` re-exports `buildProvidersRust`.
- `tests/codegen.test.ts`: new `providers.rs` describe block (header,
  consts, struct fields, determinism) + the byte-for-byte sync test now
  covers `providers.rs`.
- Verified: `bun run build` green, **69 pass / 0 fail / 508 assertions**,
  generated module compiles clean under `rustc --edition 2021
  --crate-type=lib`.

---

## 3. Proposed flock-side integration (NEEDS REVIEW — serving path)

### 3.1 Data flow

```
mesh/catalog/src/data.ts ──bun run build──▶ mesh/catalog/generated/providers.rs
        │                                    │  (checked-in, sync-tested)
        │ sync script (bun)                  ▼
        │            mesh/proxy/flock-proxy/src/roost_providers.rs
        │                              (byte-identical copy)
        ▼                                    │
mesh/proxy/flock-proxy/src/providers.rs ◀── merges ─────┘
   │  hand-written: types, ProviderSet, routing logic,
   │  FLOCK_PROVIDER_OVERLAY (13 names + elo/weight/free_tier/
   │  model_map/default_rpm/display_name), default_providers()
   ▼
config.rs (defaults, migrate_v1) — comments updated, logic unchanged
```

Sync mechanism: `flock/scripts/sync-roost-providers.ts` (bun) copies
`mesh/catalog/generated/providers.rs` → `mesh/proxy/flock-proxy/src/roost_providers.rs` and
fails non-zero on drift; a Rust unit test in `providers.rs` re-checks the
copy against `../../../catalog/generated/providers.rs` (normalized timestamp)
so `cargo test` catches a stale copy. This mirrors the herd Go-consumer
pattern (roost's own test asserts herd's `providers_generated.go` is
byte-identical).

**Alternative considered and rejected:** `build.rs` doing
`include_str!("../../../roost/generated/providers.json")` + serde parse at
startup. Rejected: adds a runtime parse dependency and keeps JSON as the
wire; the checked-in generated module is zero-cost, greppable, and matches
the herd precedent.

### 3.2 `default_providers()` rewrite (sketch)

```rust
mod roost_providers; // generated, DO NOT EDIT

struct ProviderOverlay {
    name: &'static str,
    elo: i32,
    weight: f64,
    free_tier: bool,
    default_rpm: usize,
    display_name: &'static str,          // "" = use Roost's
    model_map: &'static [(&'static str, &'static str)],
}

// Hand-maintained: WHICH Roost providers flock serves + operational tuning.
// Values carried over verbatim from the current hardcoded defaults.
const FLOCK_PROVIDER_OVERLAY: &[ProviderOverlay] = &[
    // herd (elo 1600), openrouter (1500), nvidia (1550, w 1.2,
    // free_tier, model_map {"free" -> "nvidia/nemotron-3-ultra-550b-a55b"}),
    // groq (1580, w 1.5, free_tier), together (1520), cerebras (1560, w 1.3,
    // free_tier), fireworks (1510), hyperbolic (1490, free_tier),
    // github (1500, free_tier), mistral (1530), openai (1650),
    // perplexity (1480), siliconflow (1470, free_tier).
];

pub fn default_providers() -> Vec<ProviderDef> {
    let dead: HashSet<&str> = roost_providers::ROOST_DEAD_IDS.iter().copied().collect();
    let mut out = Vec::with_capacity(FLOCK_PROVIDER_OVERLAY.len());
    for ov in FLOCK_PROVIDER_OVERLAY {
        let t = roost_providers::ROOST_PROVIDERS.iter()
            .find(|p| p.name == ov.name)
            .unwrap_or_else(|| panic!("overlay references unknown Roost provider: {}", ov.name));
        assert!(!t.router_local, "flock overlay must not include router-local {}", ov.name);
        assert!(t.enabled, "flock overlay includes disabled Roost provider {}", ov.name);
        let mut keys = vec![ProviderKey { key_env: t.key_env.into(), ..Default::default() }];
        if !t.key_env_alt.is_empty() {
            // Roost's multi-key semantic (e.g. NVIDIA_API_KEYS).
            keys.push(ProviderKey { key_env: t.key_env_alt.into(), ..Default::default() });
        }
        let no_auth = t.auth == "none";
        out.push(ProviderDef {
            name: t.name.into(),
            base_url: t.base_url.into(),
            auth: if no_auth { AuthScheme::None } else { AuthScheme::ApiKey },
            keys, no_auth,
            free_tier: ov.free_tier,
            // Roost contract: seeds are cold-start data; filter deadIds everywhere.
            models: t.seeds.iter().filter(|m| !dead.contains(*m)).map(|s| s.to_string()).collect(),
            model_map: ov.model_map.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            weight: ov.weight, elo: ov.elo,
            default_rpm: ov.default_rpm,
            display_name: if ov.display_name.is_empty() { t.display_name.into() } else { ov.display_name.into() },
            enabled: true,
            ..ProviderDef::default()
        });
    }
    out
}
```

Notes:
- `key_env` may be `""` (herd): `resolve_key_material` returns `None`
  for empty env names, and `no_auth`/`AuthScheme::None` keeps it usable —
  same as today.
- `auth` values `x-api-key`/`query-key` map to `ApiKey` for now: flock's
  `AuthScheme` has no header-name support. No regression (no x-api-key
  provider is in the 13), but **anthropic cannot join the overlay until
  header support lands** — tracked as follow-up.
- The `panic!` on unknown overlay name is intentional: a Roost
  rename/removal must fail loudly at boot, never silently drop a provider.
- `migrate_v1()`'s `.filter(|p| p.name != "nvidia")` and the empty-list
  recovery keep working unchanged.

### 3.3 Stale-advertisement fix (the actual 404-surface repair)

`default_providers()` fixes the *seed* tier. The *advertised* tier needs one
of these in `aggregate_models` / `provider_metadata`:

- **(B, recommended)** Prefer the probe-refreshed `models_cache` IDs over
  `def.models` when the cache is fresh; fall back to seeds. This makes
  discovery actually own membership, per Roost's contract. Behavior change:
  advertised set now tracks live upstream listings.
- **(C, recommended with B)** Filter merged static IDs through
  `ROOST_DEAD_IDS` (+ record serve-404s into a runtime quarantine that
  suppresses re-advertisement — flock already has `record_empty_strike`
  machinery to build on).
- **(A, deferred)** Skip `!usable` providers' static IDs in the merge.
  Strongest 404 reduction, but changes the catalog *shape*; needs a consumer
  audit first (who polls flock `/v1/models` besides herd? herd's first-class
  flock block is currently disabled).

### 3.4 Tests to update/add (flock)

- `thirteen_builtin_providers` — keep (still 13 via overlay).
- `builtin_defaults_match_astmatrix` — rewrite: expectations become
  Roost-derived (e.g. openrouter seeds grow, groq seeds = Roost's 6 minus
  deadIds). Assert base_url/key_env equality against `ROOST_PROVIDERS`.
- New: every overlay name resolves in `ROOST_PROVIDERS`; no overlay entry is
  `router_local`/`!enabled`; no generated `models` entry is in
  `ROOST_DEAD_IDS`; `key_env_alt` produces a second key (nvidia).
- New: sync test — `roost_providers.rs` byte-identical to
  `roost/generated/providers.rs` modulo the `Generated at` stamp.

### 3.5 Rollout (after review approval)

1. Implement §3.2–§3.4 in `ranch/flock`.
2. `cargo test` on yote (proxy suite; the KB records 387 passing on the
   current tree — must stay green).
3. `cargo build --release`; deploy to `/home/toxic/.flock/flock`
   (backup the current binary first).
4. Restart via the owned pitchfork flow; verify `/health`, authenticated
   `/v1/models` (spot-check dead IDs gone, seed counts match Roost),
   `POST /v1/chat/completions {"model":"free"}` E2E (the Sable regression),
   and restart durability (config still v1 → migrate path re-runs clean).
5. Post completion to fleet with commit SHAs.

---

## 4. Open questions for review

1. Overlay values are carried over verbatim from the current hardcoded
   defaults — any elo/weight/free_tier retuning wanted while we're here?
2. Approve advertisement scope: (B)+(C), or also (A) after a consumer audit?
3. Confirm no consumer depends on the current static catalog shape
   (besides herd, whose flock block is disabled).
4. Anthropic (`x-api-key`) needs header-name support in `AuthScheme` before
   it can join the overlay — separate lane?

## 5. Not in scope

- Herd's first-class flock delegation re-enablement (separate lane).
- estate-scripts-router `:25104` thinning (separate lane).
- Changing Roost's catalog data itself (no provider additions/removals here).
