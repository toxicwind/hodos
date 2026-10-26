# serve.sh — native launcher for rhodochrosite (the merged router) on :25193.
# run-nim.sh — native launcher for the rhodochrosite NIM gateway on :25193.
# 2026-10-17: replaces the dockerized miztertea/nim-proxy container (Lane A
# doctrine: estate services run under pitchfork, never docker). Same config
# store schema; also serves the Anthropic /v1/messages surface for Claude Code.
# serves the Anthropic /v1/messages surface for Claude Code.
# Secrets stay in DATA_DIR/config.json (client-key digests + NIM key pool),
# which lives outside the repo — nothing here reads or echoes credentials.
set -euo pipefail
# 2026-10-19: source the vault so key_env providers (openrouter, groq,
# mistral, github, cerebras, freeinference) resolve their API keys at
# runtime. Without this only the inline-key NVIDIA provider was live and
# every key_env provider's models 404'd. Same pattern as
# forge/router/chalcopyrite/chalcopyrite-serve.sh. Secrets stay in the
# vault; this script only exports them into the daemon's env.
if [[ -f "$HOME/.secrets" ]]; then
  set -a
  . "$HOME/.secrets"
  set +a
fi
export DATA_DIR="${DATA_DIR:-${RHODOCHROSITE_DATA_DIR:-$HOME/.rhodochrosite/nim-data}}"
export HOST="${HOST:-${RHODOCHROSITE_HOST:-127.0.0.1}}"
export PORT="${PORT:-${RHODOCHROSITE_PORT:-25193}}"
BIN="/home/toxic/pens/geode/products/rhodochrosite/proxy/target/debug/rhodochrosite"
[[ -x "$BIN" ]] || { echo "rhodochrosite binary missing at $BIN — run cargo build --release in ranch/rhodochrosite/proxy" >&2; exit 1; }
exec "$BIN"
