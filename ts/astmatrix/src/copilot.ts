/**
 * astmatrix-ts — GitHub Copilot provider.
 *
 * Handles account-token-to-session-credential exchange, resolves the correct
 * API host for the tenant's account class, and exposes a client the router can
 * call. Session credentials are short-lived (typically ~25 minutes); the client
 * refreshes them transparently and caches the account class discovered during
 * exchange.
 *
 * Endpoints:
 *   credential exchange: GET  https://api.github.com/copilot_internal/v2/token
 *   chat completions:    POST <class host>/chat/completions
 *
 * Ported from proxy/src/copilot.rs (v0.7.3).
 */

/** API host per tenant account class.
 *
 * The endpoint map returned by the credential exchange tells us which class this
 * tenant is on. Standard covers Free / Pro / Pro+. Team covers the business
 * tier. Organization covers enterprise.
 */
export const TenantClass = {
  Standard: "standard",
  Team: "team",
  Organization: "organization",
} as const;
export type TenantClass = (typeof TenantClass)[keyof typeof TenantClass];

const HOST_BY_CLASS: Record<TenantClass, string> = {
  standard: "https://api.githubcopilot.com",
  team: "https://api.business.githubcopilot.com",
  organization: "https://api.enterprise.githubcopilot.com",
};

export function apiHost(cls: TenantClass): string {
  return HOST_BY_CLASS[cls];
}

export function chatEndpoint(cls: TenantClass): string {
  return `${apiHost(cls)}/chat/completions`;
}

export function messagesEndpoint(cls: TenantClass): string {
  return `${apiHost(cls)}/v1/messages`;
}

export function responsesEndpoint(cls: TenantClass): string {
  return `${apiHost(cls)}/v1/responses`;
}

/** Session credential with absolute expiry.
 *
 * `isValid` includes a 60-second grace window so that a credential which passes
 * the check does not expire between the check and the subsequent request
 * dispatch. This was the source of intermittent 401s in 0.7.1 where a credential
 * that had > 0s remaining at check time had < 0s remaining at dispatch time.
 */
export interface SessionCredential {
  value: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshIn?: number;
}

/** Seconds of remaining life required before a credential is reused. */
export const CREDENTIAL_GRACE_SECS = 60;

export function isCredentialValid(
  cred: SessionCredential,
  now = Date.now(),
): boolean {
  return cred.expiresAt > now + CREDENTIAL_GRACE_SECS * 1000;
}

/** Coerces the `expires_at` field, which upstream sends as either an RFC3339
 * string or a unix-seconds integer depending on endpoint version. Returns epoch
 * milliseconds, or undefined when the value is unusable. */
function parseExpiry(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") {
    // Upstream sends unix SECONDS; values below this are far past expiry and
    // are more likely a milliseconds timestamp from a future API revision.
    const ms = raw < 1e11 ? raw * 1000 : raw;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Exchanges the account token for a session credential.
 *
 * `accountToken` is the long-lived token issued by the account console
 * (`gho_` / `ghu_` / `github_pat_` prefix). The `Copilot Requests` scope is
 * required on fine-grained tokens. The response includes an endpoint map from
 * which we infer the tenant class.
 */
export async function exchangeToken(
  fetchImpl: typeof fetch,
  accountToken: string,
): Promise<{ credential: SessionCredential; tenantClass: TenantClass }> {
  const resp = await fetchImpl("https://api.github.com/copilot_internal/v2/token", {
    method: "GET",
    headers: {
      Authorization: `token ${accountToken}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    return Promise.reject(
      new Error(`credential exchange returned ${resp.status}: ${await resp.text()}`),
    );
  }

  const body = (await resp.json()) as {
    token?: string;
    expires_at?: string | number;
    refresh_in?: number;
    endpoints?: Record<string, string>;
  };

  if (!body.token) {
    return Promise.reject(new Error("credential exchange response had no token"));
  }

  const expiresAt =
    parseExpiry(body.expires_at) ?? Date.now() + 1500 * 1000;

  return {
    credential: { value: body.token, expiresAt, refreshIn: body.refresh_in },
    tenantClass: tenantClassFromEndpoints(body.endpoints),
  };
}

/** Host discovery: the endpoint map tells us the account class. */
export function tenantClassFromEndpoints(
  endpoints: Record<string, string> | undefined,
): TenantClass {
  const api = endpoints?.api;
  if (!api) return TenantClass.Standard;
  if (api.includes("business")) return TenantClass.Team;
  if (api.includes("enterprise")) return TenantClass.Organization;
  return TenantClass.Standard;
}

/** Request headers for chat completions.
 *
 * `Editor-Version`, `Editor-Plugin-Version`, and `Copilot-Integration-Id` are
 * set to values the upstream expects from first-party editor clients.
 * `openai-intent` is required for the chat endpoint to route to the conversation
 * completions pipeline; without it, requests land on the code-completions
 * pipeline and behave differently.
 */
export function copilotHeaders(sessionCredential: string): Record<string, string> {
  return {
    Authorization: `Bearer ${sessionCredential}`,
    "Content-Type": "application/json",
    "Editor-Version": "vscode/1.104.1",
    "Editor-Plugin-Version": "copilot-chat/0.24.0",
    "Copilot-Integration-Id": "vscode-chat",
    "openai-intent": "conversation-completions",
  };
}

/** Copilot client with automatic credential refresh.
 *
 * Serializes refreshes through a single in-flight promise so that a burst of
 * concurrent requests after expiry performs one exchange rather than N. The
 * equivalent Rust version raced: every caller that lost the write lock still
 * re-ran `exchange_token`, so a cold cache fanned out N identical authenticated
 * requests at the account console.
 */
export class CopilotClient {
  readonly #fetch: typeof fetch;
  readonly #accountToken: string;
  #credential?: SessionCredential;
  #tenantClass: TenantClass = TenantClass.Standard;
  #inFlight?: Promise<string>;

  constructor(accountToken: string, fetchImpl: typeof fetch = fetch) {
    this.#accountToken = accountToken;
    this.#fetch = fetchImpl;
  }

  /** Returns a valid session credential, refreshing if needed. */
  async credential(): Promise<string> {
    if (this.#credential && isCredentialValid(this.#credential)) {
      return this.#credential.value;
    }
    this.#inFlight ??= exchangeToken(this.#fetch, this.#accountToken)
      .then(({ credential, tenantClass }) => {
        this.#credential = credential;
        this.#tenantClass = tenantClass;
        return credential.value;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  async tenantClass(): Promise<TenantClass> {
    // Ensure the class has been discovered; a caller reaching for the class
    // before any credential fetch would otherwise see the default.
    if (!this.#credential) await this.credential();
    return this.#tenantClass;
  }

  accountToken(): string {
    return this.#accountToken;
  }
}