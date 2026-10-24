/**
 * router_live_models.ts — live model discovery for estate-router-ts.
 *
 * Why: PROVIDER_MODELS in router_config.ts is a hardcoded curated list. It
 * goes stale (new releases, key-specific entitlements, empty lists like
 * cerebras) and it under-reports what each API key can actually serve.
 *
 * What this does: for every provider in PROVIDERS with a configured key,
 * GET {base}/models (OpenAI-compatible models endpoint) using that key,
 * and union the live IDs with the curated list. The curated list keeps
 * priority (stable aliases, :free suffix conventions); live IDs fill the
 * gaps so the router can serve *every* model each key is entitled to.
 *
 * State persists to .state/live-models.json so a restart never depends on
 * the network; refresh runs at startup (non-blocking) and every 30 min.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  PROVIDERS,
  LIVE_MODELS,
  LIVE_MODEL_META,
  getKey,
  keyOk,
  log,
} from "./router_config.ts";

const STATE_PATH = "/home/toxic/estate/.state/live-models.json";
const REFRESH_MS = 30 * 60 * 1000;

export const LIVE_STATUS: Record<
  string,
  { ok: boolean; count: number; fetchedAt: string; error?: string }
> = {};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function persist(): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(
      STATE_PATH,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          models: LIVE_MODELS,
          meta: LIVE_MODEL_META,
        },
        null,
        1,
      ),
    );
  } catch (e) {
    log("live-models persist failed:", e);
  }
}

function loadPersisted(): void {
  try {
    if (!existsSync(STATE_PATH)) return;
    const j = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (j && typeof j.models === "object") {
      for (const [p, ids] of Object.entries(j.models)) {
        if (Array.isArray(ids)) LIVE_MODELS[p] = ids.filter((x) => typeof x === "string");
      }
      log(`live-models loaded ${Object.keys(LIVE_MODELS).length} providers from disk`);
    }
    if (j && typeof j.meta === "object") {
      for (const [p, meta] of Object.entries(j.meta)) {
        if (meta && typeof meta === "object")
          LIVE_MODEL_META[p] = meta as Record<string, unknown>;
      }
    }
  } catch (e) {
    log("live-models load failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
type RawModel = { id?: string; description?: string } & Record<string, unknown>;

// Drop the long prose description — it bloats the persisted state and the
// /v1/models payload without helping routing. Everything else (pricing,
// context_length, architecture, limits...) is live metadata worth keeping.
function slimMeta(raw: RawModel): Record<string, unknown> {
  const { description, ...rest } = raw;
  return rest;
}

async function fetchProviderModels(
  p: string,
): Promise<{ ids: string[]; meta: Record<string, Record<string, unknown>> }> {
  const conf = PROVIDERS[p];
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "EstateRouter/3.1 live-discovery",
  };
  if (!conf.no_auth) {
    const k = getKey(p);
    if (!k) throw new Error("no_key");
    headers["Authorization"] = `Bearer ${k}`;
  }
  const url = `${conf.base.replace(/\/+$/, "")}/models`;
  const r = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`http_${r.status}`);
  const j = (await r.json()) as { data?: RawModel[] };
  const ids: string[] = [];
  const meta: Record<string, Record<string, unknown>> = {};
  if (Array.isArray(j?.data)) {
    for (const d of j.data) {
      if (typeof d?.id === "string" && d.id) {
        ids.push(d.id);
        meta[d.id] = slimMeta(d);
      }
    }
  }
  return { ids, meta };
}

export async function refreshLiveModels(): Promise<void> {
  for (const p of Object.keys(PROVIDERS)) {
    if (!keyOk(p)) {
      LIVE_STATUS[p] = {
        ok: false,
        count: (LIVE_MODELS[p] || []).length,
        fetchedAt: new Date().toISOString(),
        error: "no_key",
      };
      continue;
    }
    try {
      const { ids, meta } = await fetchProviderModels(p);
      LIVE_MODELS[p] = ids;
      LIVE_MODEL_META[p] = meta;
      LIVE_STATUS[p] = {
        ok: true,
        count: ids.length,
        fetchedAt: new Date().toISOString(),
      };
      log(`live-models ${p}: ${ids.length} models`);
    } catch (e) {
      LIVE_STATUS[p] = {
        ok: false,
        count: (LIVE_MODELS[p] || []).length,
        fetchedAt: new Date().toISOString(),
        error: String(e).slice(0, 120),
      };
      log(`live-models ${p} failed:`, String(e).slice(0, 120));
    }
  }
  persist();
}

export function startLiveDiscovery(): void {
  loadPersisted();
  // non-blocking: serve from curated + persisted cache immediately
  refreshLiveModels().catch((e) => log("live-models initial refresh failed:", e));
  setInterval(() => {
    refreshLiveModels().catch((e) => log("live-models refresh failed:", e));
  }, REFRESH_MS);
}
