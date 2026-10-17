/**
 * astmatrix-ts — delegation dispatch for request bodies.
 *
 * The dispatcher has two responsibilities. First, when a session is opened it
 * may inject the `delegateTask` tool schema into outgoing request bodies so the
 * orchestrator knows the tool is available. Second, when the orchestrator emits
 * a `delegateTask` tool call, the dispatcher resolves it against the session's
 * profiles and dispatches the request to the resolved target model.
 *
 * Both responsibilities are gated on the session's tier and profile set. Sessions
 * with no cross-tier profiles are never given the tool and never have their
 * bodies rewritten.
 *
 * Ported from proxy/src/router.rs.
 */

import {
  applyDelegation,
  delegateToolSchema,
  isBaseline,
  isElevated,
  resolveDelegation,
  type SessionContext,
} from "./delegation.ts";

/** A tool call as it appears in a request body. */
export interface ToolCall {
  function?: { name?: string; arguments?: string };
}

/** Dispatches a `delegateTask` tool call.
 *
 * The tool call arrives as a JSON object shaped like:
 *
 * ```json
 * { "function": { "name": "delegateTask",
 *                 "arguments": "{\"profile\":\"reasoning-deep\",\"prompt\":\"...\"}" } }
 * ```
 *
 * The `arguments` field is a JSON string embedded inside the outer JSON, so it
 * must be parsed a second time. Fix #421: parse failures return null cleanly
 * rather than propagating.
 */
export function routeDelegated(
  context: SessionContext,
  toolCall: ToolCall,
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const rawArgs = toolCall.function?.arguments;
  if (typeof rawArgs !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return null;
  }

  const profileName =
    parsed && typeof parsed === "object"
      ? (parsed as { profile?: unknown }).profile
      : undefined;
  if (typeof profileName !== "string") return null;

  const route = resolveDelegation(context, profileName);
  if (!route) return null;

  return applyDelegation(body, route);
}

/** Injects the `delegateTask` tool schema into an outgoing request body.
 *
 * Fix #419 follow-up: previously the schema was injected unconditionally.
 * Advertising it for same-tier sessions wasted tokens and confused clients that
 * did not expect the tool. The schema is now injected only when the session has
 * at least one cross-tier profile.
 */
export function injectDelegationTools(
  context: SessionContext,
  body: Record<string, unknown>,
): void {
  const hasCrossTierProfile = context.profiles.some(
    (p) => isBaseline(context.sessionTier) && isElevated(p.model),
  );
  if (!hasCrossTierProfile) return;

  const schema = delegateToolSchema(context.profiles);
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  if (tools) {
    tools.push(schema);
  } else {
    body.tools = [schema];
  }
}

/** Finds a `delegateTask` call among a message's tool calls and routes it.
 *
 * Returns the mutated body when a delegation applied, or null when no
 * `delegateTask` call was present or it did not resolve.
 */
export function routeFirstDelegation(
  context: SessionContext,
  messages: unknown,
): Record<string, unknown> | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { tool_calls?: unknown };
  const calls = last?.tool_calls;
  if (!Array.isArray(calls)) return null;

  for (const call of calls) {
    if ((call as ToolCall).function?.name !== "delegateTask") continue;
    const routed = routeDelegated(context, call as ToolCall, {});
    if (routed) return routed;
  }
  return null;
}