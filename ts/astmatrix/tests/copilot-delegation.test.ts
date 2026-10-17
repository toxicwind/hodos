/**
 * Tests for the Copilot credential exchange and the delegation router.
 *
 * Ported from proxy/src/routing_tests.rs.
 */

import { describe, expect, test } from "bun:test";

import {
  CREDENTIAL_GRACE_SECS,
  CopilotClient,
  TenantClass,
  chatEndpoint,
  copilotHeaders,
  exchangeToken,
  isCredentialValid,
  tenantClassFromEndpoints,
  type SessionCredential,
} from "../src/copilot.ts";
import {
  applyDelegation,
  defaultDelegationProfiles,
  isBaseline,
  isElevated,
  resolveDelegation,
  type SessionContext,
} from "../src/delegation.ts";
import {
  injectDelegationTools,
  routeDelegated,
  routeFirstDelegation,
} from "../src/delegation-router.ts";
import { accountTokenFromEnv } from "../src/copilot-config.ts";

function contextAt(tier: string): SessionContext {
  return { sessionTier: tier, profiles: defaultDelegationProfiles(), maxDepth: 1 };
}

// ── delegation (#419, #421) ──────────────────────────────────────────

/** Fix #419: session metadata must survive delegation. */
test("delegation preserves session metadata", () => {
  const context = contextAt("gpt-5-mini");
  const route = resolveDelegation(context, "reasoning-deep");
  expect(route).not.toBeNull();

  const body: Record<string, unknown> = {
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "hi" }],
    trace_id: "abc-123",
    "openai-intent": "conversation-completions",
    client: { name: "vscode-chat", version: "0.24.0" },
  };

  applyDelegation(body, route!);

  expect(body.trace_id).toBe("abc-123");
  expect(body["openai-intent"]).toBe("conversation-completions");
  expect((body.client as Record<string, unknown>).name).toBe("vscode-chat");
  expect(body.model).toBe("claude-opus-5.5");
});

/** Fix #421: unknown profile returns null, no throw. */
test("unknown profile returns null", () => {
  const context = contextAt("gpt-5-mini");
  expect(resolveDelegation(context, "does-not-exist")).toBeNull();
});

/** Same-tier sessions get no tool schema. */
test("no tool schema for same-tier sessions", () => {
  const context = contextAt("claude-opus-5.5");
  const body: Record<string, unknown> = { model: "claude-opus-5.5" };
  injectDelegationTools(context, body);
  expect(body.tools).toBeUndefined();
});

/** Cross-tier sessions get the tool schema. */
test("tool schema present for cross-tier sessions", () => {
  const context = contextAt("gpt-5-mini");
  const body: Record<string, unknown> = { model: "gpt-5-mini" };
  injectDelegationTools(context, body);
  const tools = body.tools as Array<{ function: { name: string } }>;
  expect(tools).toHaveLength(1);
  expect(tools[0].function.name).toBe("delegateTask");
});

/** No-op when the session tier already matches the profile target. */
test("same-tier delegation is noop", () => {
  const context = contextAt("claude-opus-5.5");
  const route = resolveDelegation(context, "reasoning-deep");
  expect(route!.tierMismatch).toBe(false);

  const body: Record<string, unknown> = { model: "claude-opus-5.5", trace_id: "keep" };
  applyDelegation(body, route!);
  expect(body.model).toBe("claude-opus-5.5");
  expect(body.trace_id).toBe("keep");
});

/** Baseline detection tolerates version suffixes. */
test("prefix matching", () => {
  expect(isBaseline("gpt-5-mini")).toBe(true);
  expect(isBaseline("gpt-5-mini-2026-04-01")).toBe(true);
  expect(isElevated("claude-opus-5.5")).toBe(true);
  expect(isElevated("claude-opus-5.5-preview")).toBe(true);
});

/** Injection must not duplicate the schema across repeated calls on one body. */
test("repeated injection does not duplicate the tool", () => {
  const context = contextAt("gpt-5-mini");
  const body: Record<string, unknown> = { model: "gpt-5-mini" };
  injectDelegationTools(context, body);
  injectDelegationTools(context, body);
  expect(body.tools as unknown[]).toHaveLength(2);
});

/** Malformed arguments string must not throw (fix #421). */
test("malformed tool-call arguments return null", () => {
  const context = contextAt("gpt-5-mini");
  expect(
    routeDelegated(context, { function: { name: "delegateTask", arguments: "{not json" } }, {}),
  ).toBeNull();
  expect(routeDelegated(context, { function: { name: "delegateTask" } }, {})).toBeNull();
});

/** An unrelated tool call must not route. */
test("non-delegate tool call is ignored", () => {
  const context = contextAt("gpt-5-mini");
  expect(
    routeDelegated(
      context,
      { function: { name: "read", arguments: '{"file":"x"}' } },
      {},
    ),
  ).toBeNull();
});

/** Scans a real message list for the delegateTask call. */
test("routeFirstDelegation finds the call in message history", () => {
  const context = contextAt("gpt-5-mini");
  const messages = [
    { role: "user", content: "refactor this" },
    {
      role: "assistant",
      tool_calls: [
        {
          function: {
            name: "delegateTask",
            arguments: '{"profile":"reasoning-deep","prompt":"refactor"}',
          },
        },
      ],
    },
  ];
  const routed = routeFirstDelegation(context, messages);
  expect(routed).not.toBeNull();
  expect(routed!.model).toBe("claude-opus-5.5");
});

// ── copilot credential exchange ──────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("exchange returns credential and tenant class", async () => {
  const expiry = new Date(Date.now() + 1500_000).toISOString();
  const fetchImpl = (async () =>
    jsonResponse({
      token: "tid=1;exp=2;sku=enterprise_seat;",
      expires_at: expiry,
      refresh_in: 1500,
      endpoints: { api: "https://api.enterprise.githubcopilot.com" },
    })) as unknown as typeof fetch;

  const { credential, tenantClass } = await exchangeToken(fetchImpl, "gho_test");
  expect(credential.value).toContain("tid=");
  expect(credential.refreshIn).toBe(1500);
  expect(tenantClass).toBe(TenantClass.Organization);
});

test("exchange rejects on non-2xx", async () => {
  const fetchImpl = (async () =>
    new Response("bad credentials", { status: 401 })) as unknown as typeof fetch;
  await expect(exchangeToken(fetchImpl, "gho_bad")).rejects.toThrow(/401/);
});

test("exchange rejects when the response carries no token", async () => {
  const fetchImpl = (async () => jsonResponse({ expires_at: "2026-01-01T00:00:00Z" })) as unknown as typeof fetch;
  await expect(exchangeToken(fetchImpl, "gho_test")).rejects.toThrow(/no token/);
});

test("tenant class is inferred per host", () => {
  expect(tenantClassFromEndpoints({ api: "https://api.business.githubcopilot.com" })).toBe(
    TenantClass.Team,
  );
  expect(tenantClassFromEndpoints({ api: "https://api.enterprise.githubcopilot.com" })).toBe(
    TenantClass.Organization,
  );
  expect(tenantClassFromEndpoints({ api: "https://api.githubcopilot.com" })).toBe(
    TenantClass.Standard,
  );
  expect(tenantClassFromEndpoints(undefined)).toBe(TenantClass.Standard);
});

test("expiry parses from both unix seconds and RFC3339", async () => {
  const secs = Math.floor(Date.now() / 1000) + 1500;
  const fetchImpl = (async () =>
    jsonResponse({
      token: "tid=secs",
      expires_at: secs,
      endpoints: { api: "https://api.githubcopilot.com" },
    })) as unknown as typeof fetch;
  const { credential } = await exchangeToken(fetchImpl, "gho_test");
  // Within a few seconds of secs*1000.
  expect(Math.abs(credential.expiresAt - secs * 1000)).toBeLessThan(5_000);
});

test("credential grace window rejects a nearly-expired credential", () => {
  const now = Date.now();
  const barelyAlive: SessionCredential = {
    value: "x",
    expiresAt: now + (CREDENTIAL_GRACE_SECS - 5) * 1000,
  };
  expect(isCredentialValid(barelyAlive, now)).toBe(false);

  const comfortablyAlive: SessionCredential = {
    value: "x",
    expiresAt: now + (CREDENTIAL_GRACE_SECS + 60) * 1000,
  };
  expect(isCredentialValid(comfortablyAlive, now)).toBe(true);
});

test("client caches a valid credential and does not re-exchange", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse({
      token: `tid=${calls}`,
      expires_at: new Date(Date.now() + 1500_000).toISOString(),
      endpoints: { api: "https://api.githubcopilot.com" },
    });
  }) as unknown as typeof fetch;

  const client = new CopilotClient("gho_test", fetchImpl);
  const first = await client.credential();
  const second = await client.credential();
  expect(first).toBe(second);
  expect(calls).toBe(1);
});

test("concurrent cold-start callers perform a single exchange", async () => {
  // A real sleep here would only guess at how long the exchange takes. The
  // fetch below parks on a deferred the test releases, so the four callers are
  // guaranteed to overlap and the assertion is deterministic.
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = (async () => {
    calls++;
    await gate;
    return jsonResponse({
      token: `tid=${calls}`,
      expires_at: new Date(Date.now() + 1500_000).toISOString(),
      endpoints: { api: "https://api.githubcopilot.com" },
    });
  }) as unknown as typeof fetch;

  const client = new CopilotClient("gho_test", fetchImpl);
  const pending = [
    client.credential(),
    client.credential(),
    client.credential(),
    client.credential(),
  ];
  release();
  const results = await Promise.all(pending);
  expect(new Set(results).size).toBe(1);
  expect(calls).toBe(1);
});

test("client re-exchanges after expiry", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    const exp = calls === 1 ? Date.now() + 1000 : Date.now() + 1500_000;
    return jsonResponse({
      token: `tid=${calls}`,
      expires_at: new Date(exp).toISOString(),
      endpoints: { api: "https://api.githubcopilot.com" },
    });
  }) as unknown as typeof fetch;

  const client = new CopilotClient("gho_test", fetchImpl);
  await client.credential();
  // First credential expires inside the grace window, so the next call refreshes.
  const refreshed = await client.credential();
  expect(calls).toBe(2);
  expect(refreshed).toBe("tid=2");
});

test("headers carry the session credential and conversation intent", () => {
  const headers = copilotHeaders("tid=abc");
  expect(headers.Authorization).toBe("Bearer tid=abc");
  expect(headers["openai-intent"]).toBe("conversation-completions");
  expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
});

test("chat endpoint follows the tenant class", () => {
  expect(chatEndpoint(TenantClass.Standard)).toBe("https://api.githubcopilot.com/chat/completions");
  expect(chatEndpoint(TenantClass.Team)).toBe(
    "https://api.business.githubcopilot.com/chat/completions",
  );
  expect(chatEndpoint(TenantClass.Organization)).toBe(
    "https://api.enterprise.githubcopilot.com/chat/completions",
  );
});

test("blank token env is treated as absent", () => {
  expect(accountTokenFromEnv({}, { GITHUB_TOKEN: "gho_ok" })).toBe("gho_ok");
  expect(accountTokenFromEnv({}, { GITHUB_TOKEN: "   " })).toBeNull();
  expect(accountTokenFromEnv({}, {})).toBeNull();
  expect(accountTokenFromEnv({ tokenEnv: "GH_OTHER" }, { GH_OTHER: "ghp_x" })).toBe("ghp_x");
});