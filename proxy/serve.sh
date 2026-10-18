# serve.sh — native launcher for hodos (the merged router) on :25193.
# run-nim.sh — native launcher for the hodos NIM gateway on :25193.
# 2026-10-17: replaces the dockerized miztertea/nim-proxy container (Lane A
# doctrine: estate services run under pitchfork, never docker). Same config
# store schema; also serves the Anthropic /v1/messages surface for Claude Code.
# serves the Anthropic /v1/messages surface for Claude Code.
# Secrets stay in DATA_DIR/config.json (client-key digests + NIM key pool),
# which lives outside the repo — nothing here reads or echoes credentials.
set -euo pipefail
export DATA_DIR="${HODOS_DATA_DIR:-$HOME/.hodos/nim-data}"
export HOST="${HODOS_HOST:-127.0.0.1}"
export PORT="${HODOS_PORT:-25193}"
BIN="/home/toxic/estate/ranch/hodos/proxy/target/release/hodos"
[[ -x "$BIN" ]] || { echo "hodos binary missing at $BIN — run cargo build --release in ranch/hodos/proxy" >&2; exit 1; }
exec "$BIN"
