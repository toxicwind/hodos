#!/bin/bash
# Pitchfork entry. Sources estate SSOT and syncs the client key, then execs flock.
set -euo pipefail
. "$HOME/estate/config/flock-ssot/env-shim.sh"
export PROXY_API_KEYS="${PROXY_API_KEYS:-$FLOCK_API_KEY}"
# Propagate the client key to tau (flocksync settings + config.yml) so a
# key rotation here never strands tau on a stale key (first-class sync).
python3 /home/toxic/estate/ranch/flock/bin/sync-flock-client-key.py || true
exec /home/toxic/.flock/flock "$@"
