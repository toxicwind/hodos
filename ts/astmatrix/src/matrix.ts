/**
 * astmatrix-ts — runtime routing matrix: ELO scores, circuit breakers,
 * fail counters, health DB, rate limiter.
 * Port of herd/internal/astmatrix/matrix.go (Go) to Bun/TypeScript.
 *
 * Note: Bun is single-threaded — Go's sync.RWMutex is elided; all
 * methods run to completion without interleaving.
 */
import { HealthDB } from "./healthdb.ts";
import { LiveCatalogReader } from "./live-catalog.ts";
import { defaultProviders, type Provider } from "./providers.ts";
import { PerProviderRateLimiter, newRateLimiter } from "./ratelimit.ts";
import { defaultConfig, type AstMatrixConfig } from "./config.ts";

export type CircuitState = "closed" | "open" | "half";

export class Matrix {
  providers: Record<string, Provider>;
  private live: LiveCatalogReader | null;
  private fail = new Map<string, number>();
  private lastFail = new Map<string, number>();
  private elo = new Map<string, number>();
  private circuit = new Map<string, CircuitState>();
  private circuitOpenUntil = new Map<string, number>();
  private fifoDepth = 0;
  private health: HealthDB;
  private rateLimiter: PerProviderRateLimiter;
  private config: AstMatrixConfig;

  private constructor(
    cfg: AstMatrixConfig,
    providers: Record<string, Provider>,
    live: LiveCatalogReader | null,
    health: HealthDB,
  ) {
    this.config = cfg;
    this.providers = providers;
    this.live = live;
    this.health = health;
    this.rateLimiter = newRateLimiter();
    for (const name of Object.keys(providers)) {
      this.elo.set(name, 1000);
      this.circuit.set(name, "closed");
    }
  }

  /**
   * Create a Matrix from config.
   *
   * Provider->models membership starts on Tack cold-start seeds; the live
   * serving sets are overlaid from the TS-exported live catalog file when
   * present. Synchronous file read — no discovery, no network. When the
   * TS side quarantines or re-admits a model it rewrites the file and the
   * next read picks it up.
   */
  static create(cfg: Partial<AstMatrixConfig>): Matrix {
    const full = defaultConfig(cfg);
    const providers = defaultProviders();
    const live = new LiveCatalogReader();
    live.syncProviderModels(providers);

    // Override provider configs from input if provided
    for (const [name, pcfg] of Object.entries(full.providers)) {
      const p = providers[name];
      if (p) {
        if (pcfg.baseUrl) p.base = pcfg.baseUrl;
        if (pcfg.keyEnv) p.keyEnv = pcfg.keyEnv;
        if (pcfg.keyEnvAlt) p.keyEnvAlt = pcfg.keyEnvAlt;
        if (pcfg.noAuth) p.noAuth = true;
      } else {
        providers[name] = {
          base: pcfg.baseUrl ?? "",
          keyEnv: pcfg.keyEnv ?? "",
          keyEnvAlt: pcfg.keyEnvAlt ?? "",
          noAuth: pcfg.noAuth ?? false,
          models: [],
        };
      }
    }

    const health = new HealthDB(full.dbPath);
    return new Matrix(full, providers, live, health);
  }

  /**
   * Re-read the TS-exported live catalog file and overlay the serving
   * sets onto the live provider table. Call from admin handlers or
   * SIGHUP-style triggers — never on a timer. Discovery lives in the TS
   * package; this only picks up the new answer.
   */
  syncLiveCatalog(): void {
    this.live?.syncProviderModels(this.providers);
  }

  liveCatalog(): LiveCatalogReader | null {
    return this.live;
  }

  /** Update ELO scores and circuit breakers after a request completes. */
  record(
    model: string,
    prov: string,
    status: number,
    lat: number,
    winner: number,
    strategy: string,
    session: string,
  ): void {
    const latMs = lat * 1000;
    this.health.recordRequest(prov, model, status, latMs, strategy, winner, session);
    const now = Date.now() / 1000;
    if (status === 200) {
      const old = this.circuit.get(prov);
      this.elo.set(prov, (this.elo.get(prov) ?? 1000) + 16);
      this.fail.set(prov, 0);
      this.lastFail.set(prov, now);
      this.circuit.set(prov, "closed");
      if (old !== "closed") {
        this.health.recordHealing(prov, model, "circuit_recovered", old ?? "", "closed", "");
      }
    } else if (status === 429) {
      this.health.recordRateLimit(prov, model, status);
      this.elo.set(prov, Math.max(100, (this.elo.get(prov) ?? 1000) - 8));
      this.fail.set(prov, (this.fail.get(prov) ?? 0) + 1);
      this.lastFail.set(prov, now);
    } else {
      const fails = (this.fail.get(prov) ?? 0) + 1;
      this.fail.set(prov, fails);
      this.lastFail.set(prov, now);
      this.elo.set(prov, Math.max(100, (this.elo.get(prov) ?? 1000) - 32));
      if (fails >= 3) {
        const old = this.circuit.get(prov);
        this.circuit.set(prov, "open");
        this.circuitOpenUntil.set(prov, now + 60);
        this.health.recordHealing(
          prov, model, "circuit_opened", old ?? "", "open",
          `${fails} consecutive failures`,
        );
      }
    }
  }

  stickyGet(sessionID: string): [string, string] {
    return this.health.stickyGet(sessionID, this.config.stickyTtl);
  }

  stickySet(sessionID: string, provider: string, model: string): void {
    this.health.stickySet(sessionID, provider, model);
  }

  /** Whether the provider's circuit breaker allows requests (mutating: open->half). */
  circuitOk(p: string): boolean {
    const st = this.circuit.get(p);
    if (st === "closed" || st === "half") return true;
    if (st === "open") {
      const now = Date.now() / 1000;
      if (now > (this.circuitOpenUntil.get(p) ?? 0)) {
        this.circuit.set(p, "half");
        return true;
      }
      return false;
    }
    return true;
  }

  eloOf(p: string): number {
    return this.elo.get(p) ?? 1000;
  }

  circuitState(p: string): CircuitState {
    return this.circuit.get(p) ?? "closed";
  }

  getHealth(): HealthDB {
    return this.health;
  }

  getRateLimiter(): PerProviderRateLimiter {
    return this.rateLimiter;
  }

  getConfig(): AstMatrixConfig {
    return this.config;
  }

  close(): void {
    this.health.close();
  }

  /**
   * Select up to n providers weighted by ELO + jitter.
   * The live catalog is synced first (request-triggered, not timer-polled).
   */
  pickWeighted(n: number): Array<[string, string]> {
    this.syncLiveCatalog();
    const scored: Array<{ score: number; name: string; model: string }> = [];
    for (const name of Object.keys(this.providers)) {
      if (!this.keyOk(name) || !this.circuitOkRead(name)) continue;
      const mid = firstModelFor(name, this.providers);
      if (!mid) continue;
      scored.push({ score: (this.elo.get(name) ?? 1000) + Math.random() * 10, name, model: mid });
    }
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const result: Array<[string, string]> = [];
    for (const s of scored) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      result.push([s.name, s.model]);
      if (result.length >= n) break;
    }
    return result;
  }

  /** Non-mutating circuit check (read path). */
  private circuitOkRead(p: string): boolean {
    const st = this.circuit.get(p);
    if (st === "closed" || st === "half") return true;
    if (st === "open") return Date.now() / 1000 > (this.circuitOpenUntil.get(p) ?? 0);
    return true;
  }

  /** Whether the provider has a usable API key. */
  keyOk(name: string): boolean {
    const p = this.providers[name];
    if (!p) return false;
    if (p.noAuth) return true;
    if (p.keyEnv && process.env[p.keyEnv]) return true;
    if (p.keyEnvAlt && process.env[p.keyEnvAlt]) return true;
    return false;
  }

  /** API key for a provider (never logged). */
  getKey(p: string): string {
    const prov = this.providers[p];
    if (!prov) return "";
    if (prov.noAuth) return "not-required-for-local";
    if (prov.keyEnv && process.env[prov.keyEnv]) return process.env[prov.keyEnv]!;
    if (prov.keyEnvAlt && process.env[prov.keyEnvAlt]) return process.env[prov.keyEnvAlt]!;
    return "";
  }

  /** FIFO admission for the fifo_matrix strategy. Returns false when full. */
  fifoEnter(): boolean {
    if (this.fifoDepth >= this.config.fifoMax) return false;
    this.fifoDepth++;
    return true;
  }

  fifoExit(): void {
    if (this.fifoDepth > 0) this.fifoDepth--;
  }
}

/** Default model for a provider. */
export function firstModelFor(
  p: string,
  providers: Record<string, Provider>,
): string {
  if (p === "herd") return "local-quality";
  const prov = providers[p];
  if (prov && prov.models.length > 0) return prov.models[0];
  return "";
}
