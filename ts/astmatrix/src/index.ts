/**
 * @flock/astmatrix — AST Matrix cloud router, ported from Go to Bun/TypeScript.
 *
 * Behavioral port of herd/internal/astmatrix (Go). Catalog data comes live
 * from @ranch/roost — no generated files.
 */
export { defaultConfig, type AstMatrixConfig, type ProviderCfg } from "./config.ts";
export { HealthDB, type ProviderHealth } from "./healthdb.ts";
export {
  LiveCatalogReader,
  liveCatalogPath,
  reportServe404,
  LIVE_CATALOG_CONTRACT,
  type ProviderLike,
} from "./live-catalog.ts";
export { Matrix, firstModelFor, type CircuitState } from "./matrix.ts";
export {
  defaultProviders,
  deadIDSet,
  filterDeadIDs,
  aliasTargetServable,
  codingAlias,
  herdLocalAliases,
  isLocalSwapModelId,
  resolveModel,
  isExplicit,
  isAST,
  type Provider,
} from "./providers.ts";
export {
  RegistryProviders,
  keyEnvFor,
  keyEnvOverride,
  type ProviderDef,
  type ModelEntry,
} from "./registry.ts";
export {
  PerProviderRateLimiter,
  newRateLimiter,
  parseRetryAfter,
  parseRateLimitReset,
} from "./ratelimit.ts";
export { Router, strategies, type RouteResult } from "./router.ts";
export {
  CopilotClient,
  TenantClass,
  apiHost,
  chatEndpoint,
  messagesEndpoint,
  responsesEndpoint,
  copilotHeaders,
  exchangeToken,
  isCredentialValid,
  tenantClassFromEndpoints,
  CREDENTIAL_GRACE_SECS,
  type SessionCredential,
} from "./copilot.ts";
export {
  accountTokenFromEnv,
  orchestratorModel,
  delegationProfiles,
  DEFAULT_COPILOT_TOKEN_ENV,
  COPILOT_REFRESH_MARGIN_SECS,
  type CopilotConfig,
} from "./copilot-config.ts";
export {
  BASELINE_MODELS,
  ELEVATED_MODELS,
  applyDelegation,
  defaultDelegationProfiles,
  delegateToolSchema,
  isBaseline,
  isElevated,
  resolveDelegation,
  type DelegationProfile,
  type DelegationRoute,
  type SessionContext,
} from "./delegation.ts";
export {
  injectDelegationTools,
  routeDelegated,
  routeFirstDelegation,
  type ToolCall,
} from "./delegation-router.ts";
export { uiHTML, serveUI, uiData } from "./ui.ts";
