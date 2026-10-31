# rhodochrosite — estate multi-provider inference gateway

> 🗺️ Part of [**geode**](../../README.md) — one of the estate's five pens.

The canonical OpenAI/Anthropic-compatible inference gateway on **:25193**.
Formerly `hodos` (née `flock`) — renamed 2026-10-26, see
[`docs/rhodochrosite-rename.lapidary`](../../docs/rhodochrosite-rename.lapidary).

## The one rule

**All model traffic goes through rhodochrosite.** Agents (tau, kappa, rig),
products, and dashboards never talk to providers directly — they hit
`http://127.0.0.1:25193/v1` and rhodochrosite routes to the right upstream
with rate-limiting, failover, circuit breakers, and per-key token buckets.

## Layout

| Path | What it is |
|---|---|
| [`proxy/`](proxy/) | **The live Rust gateway binary** — start here. `proxy/README.md` is the real, source-rebuilt architecture doc. |
| `routers/` | TS router experiments (EstateRouter strategies, `open-sse`, `proxy-engine`) — lab surface, not the live path |
| `ts/` | TS/astmatrix prototyping that fed the proxy design |
| `client/`, `dashboard/` | Web surfaces for the proxy dash |
| `kb/` | Knowledge-base merge pairs |
| `reference/` | Upstream API snapshots (NVIDIA NIM) |

## Live facts

- **Port**: 25193 (`ports.env` SSOT)
- **State DB**: `~/.hodos-data/rhodochrosite_state.db` (circuits, lanes, provider health, sticky sessions)
- **Provider catalog**: generated — `proxy/src/roost_providers.rs` + `proxy/src/mimetite_providers.rs` (from `@toxicwind/mimetite`; never hand-edit)
- **Upstreams**: NVIDIA NIM, Groq, Cerebras, Together, Mistral, OpenRouter, SiliconFlow, Google-EAP (opal), bornite (local VRAM :25100), free-inference
- **Known historical bug (fixed in source)**: the Oct 28 binary answered some buffered requests with a bare `200 OK` text/plain body — rebuilt from source 2026-10-30 23:54; wire-verified relaying real upstream JSON after.
