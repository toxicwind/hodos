/**
 * astmatrix-ts — thin reader for the live catalog JSON exported by the
 * TS package (@ranch/roost ModelCatalog.writeLiveCatalog).
 *
 * Port of herd/internal/astmatrix/live_catalog.go (Go) to Bun/TypeScript.
 *
 * This file contains NO catalog logic. It does not discover, prune, or
 * quarantine anything. The TS package is the brain: it owns the provider
 * definitions, the /models adapters, live discovery, and the two-strike
 * quarantine state machine. It writes the ANSWER (derived serving sets) to a
 * JSON file; this reader loads that file and hands the serving sets to the
 * provider table.
 *
 * Contract: ranch-roost/live-catalog/v1
 *   { "contract": ..., "generatedAt": ..., "deadIds": [...],
 *     "providers": { "<name>": { "serving": [...], "quarantined": [...],
 *                               "discovered": bool } } }
 *
 * When the live file is absent or unreadable, providers fall back to their
 * generated cold-start seeds (dead-filtered). The file is re-read whenever
 * its mtime changes, so a TS-side quarantine propagates without a restart
 * and without any polling timer on our side.
 */
import { statSync, readFileSync } from "node:fs";

export const LIVE_CATALOG_CONTRACT = "ranch-roost/live-catalog/v1";

/** The pre-rename name, still emitted by older writers. Accepted on read. */
export const LEGACY_CATALOG_CONTRACT = "estate-scripts-providers/live-catalog/v1";

/** Resolve the live catalog file path: env override first, then default. */
export function liveCatalogPath(): string {
  return (
    process.env.estate-scripts_LIVE_CATALOG ||
    "/home/toxic/estate/.state/provider-catalog.live.json"
  );
}

interface LiveCatalogProvider {
  serving: string[];
  quarantined: string[];
  discovered: boolean;
}

interface LiveCatalogData {
  contract: string;
  generatedAt: string;
  deadIds: string[];
  providers: Record<string, LiveCatalogProvider>;
}

export interface ProviderLike {
  models: string[];
}

/** Reads the TS-exported live catalog file. Pure data. */
export class LiveCatalogReader {
  private mtimeMs = 0;
  private data: LiveCatalogData | null = null;

  constructor(private readonly path: string = liveCatalogPath()) {}

  /** The file this reader watches (mirrors Go's Path()). */
  watchedPath(): string {
    return this.path;
  }

  getPath(): string {
    return this.path;
  }

  /**
   * Re-read the file when its mtime changed. Returns the current data, or
   * null when the file is absent/unreadable/invalid. Never throws: a bad
   * file is simply treated as "no live data".
   */
  private refreshIfStale(): LiveCatalogData | null {
    let mtMs: number;
    try {
      mtMs = statSync(this.path).mtimeMs;
    } catch {
      return null;
    }
    if (this.data !== null && mtMs <= this.mtimeMs) return this.data;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return null;
    }
    let d: LiveCatalogData;
    try {
      d = JSON.parse(raw) as LiveCatalogData;
    } catch {
      return null;
    }
    if (d.contract !== LIVE_CATALOG_CONTRACT) {
      // Silently returning null here is what let a pre-rename contract file sit
      // on disk while every consumer quietly fell back to cold-start seeds. The
      // mismatch is now loud, and the legacy name is accepted so the estate keeps
      // working across the roost rename.
      if (d.contract === LEGACY_CATALOG_CONTRACT) {
        console.warn(
          `[live-catalog] ${this.path} declares the pre-rename contract ${d.contract}; ` +
            `accepting it, but rewrite the file with ${LIVE_CATALOG_CONTRACT}`,
        );
      } else {
        console.warn(
          `[live-catalog] ${this.path} declares unknown contract ${JSON.stringify(d.contract)}; ` +
            `expected ${LIVE_CATALOG_CONTRACT}. Falling back to cold-start seeds.`,
        );
        return null;
      }
    }
    if (!d.providers) d.providers = {};
    this.data = d;
    this.mtimeMs = mtMs;
    return d;
  }

  /**
   * Live serving list for a provider.
   * ok=false means no live data (file absent/invalid or provider not listed);
   * callers fall back to generated cold-start seeds.
   */
  servingModels(provider: string): { models: string[]; ok: boolean } {
    const d = this.refreshIfStale();
    if (!d) return { models: [], ok: false };
    const p = d.providers[provider];
    if (!p) return { models: [], ok: false };
    return { models: [...p.serving], ok: true };
  }

  /**
   * Overlay the live serving sets onto a provider table. Providers with
   * live data get their models replaced verbatim; providers without live
   * data keep whatever they had (generated seeds). Pure data overlay —
   * no discovery, no quarantine decisions here.
   */
  syncProviderModels(providers: Record<string, ProviderLike>): void {
    const d = this.refreshIfStale();
    if (!d) return;
    for (const name of Object.keys(providers)) {
      const live = d.providers[name];
      if (!live) continue;
      providers[name].models = [...live.serving];
    }
  }
}

// ------------------------------------------------------------------
// 404 event reporting — we report, the TS brain decides.
// ------------------------------------------------------------------

function serve404Endpoint(): string {
  return (
    process.env.estate-scripts_CATALOG_404_URL ||
    "http://127.0.0.1:25200/admin/catalog/serve-404"
  );
}

/**
 * Post a serve-time 404 to the TS catalog brain. Best-effort: short
 * timeout, failures are dropped, never retried, never blocking. The TS
 * side quarantines the id and rewrites the live catalog file; we pick the
 * new serving set up on our next read.
 */
export async function reportServe404(
  provider: string,
  model: string,
): Promise<void> {
  const url = serve404Endpoint();
  if (!url) return;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const tok = process.env.estate-scripts_CATALOG_ADMIN_TOKEN;
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ provider, model }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch {
    // best-effort: drop failures
  }
}
