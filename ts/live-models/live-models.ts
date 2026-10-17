/**
 * flock/ts/live-models — live model discovery scheduler (Bun/TS).
 *
 * Ported from estate-scripts-router's router_live_models.ts. A thin scheduler
 * around the Roost package (../roost/src): for every provider with a
 * configured key, run Roost's adapter-aware discovery (OpenAI / Google
 * v1beta / Mistral / static / none shapes), feed the result into the
 * unified ModelCatalog (which owns serving membership, quarantine, and
 * persistence), and keep router-side live metadata (pricing, context
 * length...) that /v1/models and the strategy tier's modelFree consume.
 *
 * State:
 * - provider-catalog.json — Roost-owned (quarantine, miss streaks,
 *   everDiscovered). Written atomically by the catalog itself.
 * - live-models.json — scheduler-owned { fetchedAt, meta } (per-model live
 *   metadata for /v1/models + modelFree). On upgrade from the old shape,
 *   a legacy { models } map is folded into the catalog once via the
 *   Roost v1 migration path so the warm cache survives.
 *
 * Refresh is EVENT-DRIVEN (no timers): startup (non-blocking), SIGHUP,
 * POST /admin/reload, and request-triggered (singleflight dedupes).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { discover } from "../../roost/src/index.ts";
import type { ModelCatalog } from "../../roost/src/index.ts";

export const META_STATE_PATH = "/home/toxic/estate/.state/live-models.json";

export const LIVE_STATUS: Record<
  string,
  { ok: boolean; count: number; fetchedAt: string; error?: string }
> = {};

/** Router-side live metadata: provider -> model id -> slim metadata (no description). */
export const LIVE_MODEL_META: Record<string, Record<string, Record<string, unknown>>> = {};

export interface LiveDiscoveryDeps {
  catalog: ModelCatalog;
  /** Key-present check for a provider (the strategy tier's keyOkFor). */
  keyOk: (provider: string) => boolean;
  /** Optional: atomic Roost catalog state path persisted after each sweep. */
  catalogStatePath?: string;
  /** Override for tests. Defaults to META_STATE_PATH. */
  metaStatePath?: string;
  log?: (...args: unknown[]) => void;
}

const dlog = (deps: LiveDiscoveryDeps, ...args: unknown[]): void =>
  (deps.log ?? console.log)(...args);

// ---------------------------------------------------------------------------
// Persistence (scheduler-owned live metadata; catalog state is Roost-owned)
// ---------------------------------------------------------------------------
function persistMeta(deps: LiveDiscoveryDeps): void {
  const path = deps.metaStatePath ?? META_STATE_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        { fetchedAt: new Date().toISOString(), meta: LIVE_MODEL_META },
        null,
        1,
      ),
    );
  } catch (e) {
    dlog(deps, "live-models persist failed:", e);
  }
}

function loadPersistedMeta(deps: LiveDiscoveryDeps): void {
  const path = deps.metaStatePath ?? META_STATE_PATH;
  try {
    if (!existsSync(path)) return;
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (j && typeof j.meta === "object") {
      for (const [p, meta] of Object.entries(j.meta)) {
        if (meta && typeof meta === "object")
          LIVE_MODEL_META[p] = meta as Record<string, Record<string, unknown>>;
      }
    }
    // Upgrade path: fold a legacy { models } map into the catalog once so
    // the warm cache survives the migration. Roost's v1 migration marks
    // them everDiscovered and filters the dead list; the next refresh
    // reconciles everything via the normal miss-streak rules.
    if (j && typeof j.models === "object") {
      deps.catalog.loadJSON({ live: j.models });
      dlog(deps, "live-models migrated legacy models map into the catalog");
    }
  } catch (e) {
    dlog(deps, "live-models load failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
type RawModel = Record<string, unknown>;

// Drop the long prose description — it bloats the persisted state and the
// /v1/models payload without helping routing. Everything else (pricing,
// context_length, architecture, limits...) is live metadata worth keeping.
export function slimMeta(raw: RawModel): Record<string, unknown> {
  const { description, ...rest } = raw;
  return rest;
}

/** In-flight refresh promise for singleflight: concurrent triggers share one run. */
let refreshInFlight: Promise<void> | null = null;

export function refreshLiveModels(deps: LiveDiscoveryDeps): Promise<void> {
  // Singleflight: if a refresh is already running, wait for it instead of
  // starting a duplicate discovery sweep.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshLiveModelsInner(deps).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshLiveModelsInner(deps: LiveDiscoveryDeps): Promise<void> {
  const catalog = deps.catalog;
  for (const p of catalog.providerNames()) {
    if (!deps.keyOk(p)) {
      LIVE_STATUS[p] = {
        ok: false,
        count: catalog.servingModels(p).length,
        fetchedAt: new Date().toISOString(),
        error: "no_key",
      };
      continue;
    }
    try {
      const def = catalog.getDef(p)!;
      const result = await discover(def, { timeoutMs: 15000 });
      catalog.applyDiscovery(p, result);
      const meta: Record<string, Record<string, unknown>> = {};
      const ids: string[] = [];
      if (result.ok) {
        for (const [id, raw] of Object.entries(result.meta ?? {})) {
          if (raw && typeof raw === "object") meta[id] = slimMeta(raw as RawModel);
        }
        ids.push(...(result.ids ?? []));
      }
      LIVE_MODEL_META[p] = meta;
      LIVE_STATUS[p] = {
        ok: result.ok,
        count: ids.length,
        fetchedAt: new Date().toISOString(),
        ...(result.ok ? {} : { error: (result.error ?? "unknown").slice(0, 120) }),
      };
      dlog(
        deps,
        `live-models ${p}: ${result.ok ? `${(result.ids ?? []).length} models` : `failed (${result.error})`}`,
      );
    } catch (e) {
      LIVE_STATUS[p] = {
        ok: false,
        count: catalog.servingModels(p).length,
        fetchedAt: new Date().toISOString(),
        error: String(e).slice(0, 120),
      };
      dlog(deps, `live-models ${p} failed:`, String(e).slice(0, 120));
    }
  }
  if (deps.catalogStatePath) {
    await catalog.saveToFile(deps.catalogStatePath);
  }
  persistMeta(deps);
}

/**
 * Event-driven discovery startup. Non-blocking: serve from seeds + persisted
 * catalog state immediately, refresh in the background. Refresh triggers:
 * - SIGHUP: explicit operator signal to re-discover.
 * - POST /admin/reload: calls refreshLiveModels() directly.
 * - Request-triggered: call refreshLiveModels() when a request observes
 *   stale data (singleflight dedupes concurrent triggers).
 */
export function startLiveDiscovery(deps: LiveDiscoveryDeps): void {
  loadPersistedMeta(deps);
  refreshLiveModels(deps).catch((e) => dlog(deps, "live-models initial refresh failed:", e));
  process.on("SIGHUP", () => {
    dlog(deps, "live-models SIGHUP refresh triggered");
    refreshLiveModels(deps).catch((e) => dlog(deps, "live-models SIGHUP refresh failed:", e));
  });
}
