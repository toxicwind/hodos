#!/usr/bin/env python3
"""Sync flock's client key into tau's config locations.

Single source of truth: /home/toxic/.flock-data/client-key.corral
Targets:
  - /home/toxic/.tau/agent/extensions/tau-flocksync/settings.json (apiKey)
  - /home/toxic/.tau/config.yml (providers.openai-compatible.apiKey)

Called by ranch/flock/bin/flock-run.sh on every flock start, so a key
rotation on the flock side propagates to tau automatically instead of
drifting into a 401. Idempotent: no-ops when keys already match.

Backups: <file>.bak-synckey kept alongside each target.
"""
import json
import os
import re
import shutil
import sys

HOME = os.path.expanduser("~")
CORRAL = os.path.join(HOME, ".flock-data", "client-key.corral")
FLOCKSYNC_SETTINGS = os.path.join(
    HOME, ".tau", "agent", "extensions", "tau-flocksync", "settings.json"
)
TAU_CONFIG = os.path.join(HOME, ".tau", "config.yml")


def backup(path: str) -> None:
    bak = path + ".bak-synckey"
    shutil.copy2(path, bak)


def sync_flocksync_settings(key: str) -> bool:
    """Return True if the file was changed."""
    if not os.path.exists(FLOCKSYNC_SETTINGS):
        print(f"skip: {FLOCKSYNC_SETTINGS} not found", file=sys.stderr)
        return False
    with open(FLOCKSYNC_SETTINGS) as f:
        data = json.load(f)
    if data.get("apiKey") == key:
        return False
    backup(FLOCKSYNC_SETTINGS)
    data["apiKey"] = key
    with open(FLOCKSYNC_SETTINGS, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(FLOCKSYNC_SETTINGS, 0o600)
    return True


def sync_tau_config(key: str) -> bool:
    """Surgical replace of the openai-compatible apiKey line. Return True if changed."""
    if not os.path.exists(TAU_CONFIG):
        print(f"skip: {TAU_CONFIG} not found", file=sys.stderr)
        return False
    with open(TAU_CONFIG) as f:
        text = f.read()
    # Match the apiKey line indented under openai-compatible (4 spaces).
    pat = re.compile(r"(?m)^    apiKey: .*$")
    m = pat.search(text)
    if not m:
        print("skip: no indented apiKey line found in config.yml", file=sys.stderr)
        return False
    if m.group(0).strip() == f"apiKey: {key}":
        return False
    backup(TAU_CONFIG)
    text = pat.sub(f"    apiKey: {key}", text, count=1)
    with open(TAU_CONFIG, "w") as f:
        f.write(text)
    return True


def main() -> int:
    if not os.path.exists(CORRAL):
        print(f"fatal: {CORRAL} not found", file=sys.stderr)
        return 1
    with open(CORRAL) as f:
        key = f.read().strip()
    if not key:
        print("fatal: corral key is empty", file=sys.stderr)
        return 1

    changed = []
    if sync_flocksync_settings(key):
        changed.append("flocksync/settings.json")
    if sync_tau_config(key):
        changed.append("tau/config.yml")

    if changed:
        print(f"synced flock client key -> {', '.join(changed)}")
    else:
        print("flock client key already in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())

def sync_agent_config(key: str) -> bool:
    """Sync to /home/toxic/.tau/agent/config.yml (the file tau actually reads)."""
    import re
    path = os.path.join(HOME, ".tau", "agent", "config.yml")
    if not os.path.exists(path):
        return False
    with open(path) as f:
        content = f.read()
    new_content = re.sub(
        r"(baseUrl: http://127\.0\.0\.1:25193/v1\n\s+apiKey: )[^\n]+",
        r"\g<1>" + key,
        content
    )
    if new_content == content:
        return False
    backup(path)
    with open(path, "w") as f:
        f.write(new_content)
    return True
