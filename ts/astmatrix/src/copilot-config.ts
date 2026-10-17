/**
 * astmatrix-ts — Copilot account credential exchange.
 *
 * `CopilotConfig` is the on-disk representation. The account token is NOT stored
 * in config: it is read from the environment at client construction so that
 * `data/config.json` never carries a credential. The delegation profile set and
 * the orchestrator tier live in config because they are not secrets.
 */

import {
  defaultDelegationProfiles,
  type DelegationProfile,
} from "./delegation.ts";

export interface CopilotConfig {
  /** Env var holding the account token. Defaults to GITHUB_TOKEN. */
  tokenEnv?: string;
  /** Delegation profiles available to sessions opened under this provider. */
  delegationProfiles?: DelegationProfile[];
  /** The tier sessions are opened at. */
  orchestratorModel?: string;
}

/** Env var consulted when `tokenEnv` is unset. */
export const DEFAULT_COPILOT_TOKEN_ENV = "GITHUB_TOKEN";

/** Accounts with this much remaining life are refreshed before reuse. */
export const COPILOT_REFRESH_MARGIN_SECS = 1500;

const DEFAULT_ORCHESTRATOR = "gpt-5-mini";

export function orchestratorModel(cfg: CopilotConfig): string {
  return cfg.orchestratorModel || DEFAULT_ORCHESTRATOR;
}

export function delegationProfiles(cfg: CopilotConfig): DelegationProfile[] {
  const set = cfg.delegationProfiles ?? [];
  return set.length > 0 ? set : defaultDelegationProfiles();
}

/** Returns the configured account token, or null when the env var is unset or
 * blank. A blank value is treated as absent rather than sent as an empty
 * credential, which the upstream would reject with an opaque 401. */
export function accountTokenFromEnv(
  cfg: CopilotConfig,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[cfg.tokenEnv || DEFAULT_COPILOT_TOKEN_ENV];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}