/**
 * astmatrix-ts — configuration.
 * Port of herd/internal/astmatrix/config.go (Go) to Bun/TypeScript.
 */

export interface ProviderCfg {
  baseUrl?: string;
  keyEnv?: string;
  keyEnvAlt?: string;
  noAuth?: boolean;
}

export interface AstMatrixConfig {
  enabled: boolean;
  strategy: string;
  maxParallel: number;
  dbPath: string;
  stickyTtl: number;
  fifoMax: number;
  providers: Record<string, ProviderCfg>;
}

export function defaultConfig(partial: Partial<AstMatrixConfig> = {}): AstMatrixConfig {
  const cfg: AstMatrixConfig = {
    enabled: partial.enabled ?? false,
    strategy: partial.strategy || "hybrid",
    maxParallel: partial.maxParallel && partial.maxParallel > 0 ? partial.maxParallel : 4,
    dbPath: partial.dbPath || "/home/toxic/estate/data/ast_matrix.db",
    stickyTtl: partial.stickyTtl && partial.stickyTtl > 0 ? partial.stickyTtl : 1800,
    fifoMax: partial.fifoMax && partial.fifoMax > 0 ? partial.fifoMax : 64,
    providers: partial.providers ?? {},
  };
  return cfg;
}
