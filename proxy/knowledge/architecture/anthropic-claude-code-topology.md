# Anthropic → Claude Code → hodos topology

**Last verified from code:** 2026-10-21. Facts in this doc were read from
source, not from other docs (docs on this box are unreliable — code is absolute).

## TL;DR

There is **no real Anthropic API** on this box. "Anthropic" is **hodos** — a
Rust router (the evolution of the `miztertea/nim-proxy`) that exposes an
**Anthropic-compatible `/v1/messages` surface** and **translates** those
requests into OpenAI-chat calls against **9 upstream providers**. Claude Code
(or any Anthropic client) talks to hodos; hodos does the model routing.

```text
Claude Code CLI
   │  ANTHROPIC_BASE_URL → hodos
   ▼
hodos  (Rust router, :25193)
   │  /v1/messages (Anthropic) ── translate ──► /v1/chat/completions (OpenAI)
   │
   ├─ nvidia
   ├─ groq
   ├─ together
   ├─ cerebras
   ├─ github
   ├─ openai
   ├─ siliconflow
   ├─ freeinference
   └─ google
```

## The single env lever

`~/.config/claude/env` (Claude Code's env file) sets:

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:8000/v1"
export ANTHROPIC_CUSTOM_MODEL_OPTION="deepseek-ai/deepseek-v4-pro-0813"
```

**Stale fact:** `:8000` is wrong. hodos serves `:25193` (see
`pitchfork.d/hodos.toml` → `PORT = "25193"`). The `:8000` value predates the
2026-10-17 move off the dockerized nim-proxy container to the native binary.
Any Anthropic-style CLI pointed at `:8000` gets **connection refused** unless
hodos is also bound there (it is not).

The auth token is an OpenAI-style **agent key**, not an Anthropic key:
`ANTHROPIC_AUTH_TOKEN` carries an `npk_…`-prefixed value. There is no
`sk-ant-` Anthropic credential anywhere on the box.

## hodos: the "Anthropic proxy" that is really the router

Source: `/home/toxic/estate/ranch/hodos/proxy`.

- **Serves both wire formats** (`README.md` + `anthropic.rs`):
  - Anthropic `/v1/messages` (Claude Code works out of the box)
  - OpenAI `/v1/chat/completions` and `/v1/models`
- **Anthropic → OpenAI translation** (`src/anthropic.rs`, ~700 lines):
  - `tool_use` content blocks → OpenAI `tool_calls`
  - `tool_result` blocks → OpenAI `tool` messages
  - system prompt, `tools`, `tool_choice`, `stop_sequences` all translated
- **Model resolution for Claude clients** (`anthropic.rs:34-44`):
  - If the client asks for `claude-*` (or omits the model), hodos serves the
    **default NIM model**: `nvidia/nemotron-3.5-super-vl-120b-a12b`
    (`DEFAULT_ANTHROPIC_MODEL`, overridable via
    `HODOS_ANTHROPIC_DEFAULT_MODEL` env).
  - Non-`claude` model names pass through verbatim.
- **Providers** (`src/providers.rs:default_providers()`): 9 built-ins
  (nvidia, groq, together, cerebras, github, openai, siliconflow,
  freeinference, google). Endpoints are config-driven —
  `upstream.base_url` from the vault/store; `/v1`-doubling is guarded by
  regression tests (`providers.rs:693-763`).
- **Rate-limit brains**: FIFO dispatcher → key-pool → governor
  (`knowledge/architecture/index.md`), with per-provider RPM/circuit breakers.
- **Launcher**: `serve.sh` → `target/release/hodos` (release Rust binary),
  supervised by pitchfork (`pitchfork.d/hodos.toml`, port 25193, `auto=["start"]`).

## History / lineage

- Upstream was the dockerized `miztertea/nim-proxy` container.
- **2026-10-17**: hodos became the native Rust binary under pitchfork
  (Lane A doctrine: estate services run natively, never docker). Same config
  store schema, and now also the Anthropic `/v1/messages` surface.
- `CHANGELOG.md` documents the nim-proxy → hodos evolution.

## Other "anthropic proxies" on the box (do NOT confuse with hodos)

- **`ranch/vendored/antigravity-claude-proxy`** — a *separate* Node/Express
  proxy exposing an Anthropic-compatible API backed by **Google Cloud Code**
  (Antigravity), for using Gemini/Claude via Google accounts with multi-account
  quota. Runs on **:8080** (`npm start`), not :8000/:25193. It is NOT wired
  into the Claude Code env path; it is a standalone alternative. Potential
  future: fold its Google-account/quota logic into hodos (open question — see
  decision record in this repo if that is pursued).
- `ranch/corral/src/nimProxy.ts` — a TypeScript nim proxy used by corral, not
  the serving router.

## Operations

- **Is hodos running?** `pitchfork status | grep hodos` (expect `running`);
  `ss -ltn | grep 25193`.
- **Start/stop:** `pitchfork start hodos` / `pitchfork stop hodos`. The daemon
  is `auto=["start"]` but may need one manual start if the box was up before
  pitchfork adopted it.
- **Fix Claude Code pointing at the dead :8000:** update
  `~/.config/claude/env`:
  `export ANTHROPIC_BASE_URL="http://127.0.0.1:25193/v1"`
- **Default Claude-backing model:** override via
  `HODOS_ANTHROPIC_DEFAULT_MODEL` env in `pitchfork.d/hodos.toml`.

## Quick verification (code-anchored)

```bash
# 1. hodos is up
pitchfork status | grep hodos          # running
ss -ltn | grep 25193                   # LISTEN

# 2. the Anthropic surface answers (expect HTTP 200, a JSON error not conn refused)
curl -s -o /dev/null -w '%{http_code}\n' \
  -m 6 -X POST http://127.0.0.1:25193/v1/messages \
  -H 'content-type: application/json' \
  -H "x-api-key: ${ANTHROPIC_AUTH_TOKEN}" \
  -d '{}'

# 3. models list
curl -s -m 6 http://127.0.0.1:25193/v1/models | head
```