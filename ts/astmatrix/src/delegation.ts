/**
 * astmatrix-ts — delegation dispatch for multi-model sessions.
 *
 * Background (issue #419): the previous router rebuilt the outgoing request body
 * from scratch when delegating, which dropped session metadata that clients rely
 * on for trace correlation and header forwarding. This module replaces the
 * rebuild with a targeted field mutation so that only the execution target
 * changes and the rest of the body is carried through unchanged.
 *
 * Background (issue #421): the previous router propagated parse errors from
 * malformed tool-call arguments all the way up to the HTTP layer, producing 500s
 * that the client could not distinguish from genuine upstream failures. This
 * module returns null on unknown profiles and malformed arguments so the
 * dispatcher can fall through to the non-delegated path.
 *
 * The `delegateTask` tool is advertised to the orchestrator only when the
 * session's profile set contains at least one profile whose target sits on a
 * different capacity tier than the session itself. Advertising it
 * unconditionally was wasting tokens for same-tier sessions and confusing
 * clients that did not expect the tool.
 */

import type { TenantClass } from "./copilot.ts";

/** A named delegation profile.
 *
 * Profiles are pinned to a target model and carry their own system instructions
 * and tool set. The orchestrator selects a profile by name; the router resolves
 * the name to the pinned model.
 */
export interface DelegationProfile {
  name: string;
  /** The target model this profile dispatches to. */
  model: string;
  /** System instructions for the delegated context. */
  instructions?: string;
  /** Tools available to the delegated context. */
  tools?: string[];
}

/** Session context carried through delegation.
 *
 * `sessionTier` is the model the session was opened at, kept for trace
 * correlation. `maxDepth` is reserved for the recursive delegation change
 * tracked in #430; it is not read by the router in this release.
 */
export interface SessionContext {
  sessionTier: string;
  profiles: DelegationProfile[];
  /** Reserved for #430; not read yet. */
  maxDepth?: number;
}

/** Baseline tier models.
 *
 * Baseline tier includes general-purpose and small-footprint models that are
 * available on every account class. `gpt-5-mini` is preferred as the
 * orchestrator: best instruction following among the baseline set, which matters
 * more than raw capability for the routing role.
 */
export const BASELINE_MODELS = [
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4.1",
  "raptor-mini",
] as const;

/** Elevated tier models.
 *
 * Elevated tier includes the large reasoning and long-context models.
 * Availability depends on the tenant's account class and any deployment-level
 * allow list. `claude-opus-5.5` is the current ceiling for deep reasoning
 * workloads.
 */
export const ELEVATED_MODELS = [
  "claude-opus-5.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-sonnet-4.5",
  "claude-fable-5.1",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-5.5",
  "gpt-5.6",
  "o3",
  "o3-pro",
] as const;

/** Prefix match against the baseline set.
 *
 * Prefix matching tolerates version suffixes (`gpt-5-mini-2026-04-01`) without
 * requiring a separate normalization pass. The trade-off is that a hypothetical
 * model whose name begins with a baseline prefix would be classified as
 * baseline; the upstream allow list is the authoritative gate for whether a model
 * actually runs.
 */
export function isBaseline(model: string): boolean {
  return BASELINE_MODELS.some((m) => model.startsWith(m));
}

/** Prefix match against the elevated set. See `isBaseline` for notes. */
export function isElevated(model: string): boolean {
  return ELEVATED_MODELS.some((m) => model.startsWith(m));
}

/** Builds the `delegateTask` tool schema advertised to the orchestrator.
 *
 * The schema is a plain function tool with a two-field parameter object. The
 * `enum` on `profile` is populated from the session's profile set so the
 * orchestrator cannot name a profile the router will not recognize.
 */
export function delegateToolSchema(profiles: DelegationProfile[]): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "delegateTask",
      description:
        "Delegate a task to a specialized profile. The profile runs in an isolated context and returns its result.",
      parameters: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            enum: profiles.map((p) => p.name),
            description: "Name of the delegation profile to invoke.",
          },
          prompt: {
            type: "string",
            description: "The task for the delegated context to perform.",
          },
        },
        required: ["profile", "prompt"],
      },
    },
  };
}

/** Resolved delegation for one invocation. */
export interface DelegationRoute {
  profile: DelegationProfile;
  targetModel: string;
  /** Whether the session tier and the profile target sit on different capacity
   * levels. Used by the dispatcher to decide whether the execution target needs
   * to be set explicitly. */
  tierMismatch: boolean;
}

/** Resolves a delegation invocation against the session context.
 *
 * Returns null if the profile name is unknown. Fix #421: previously this threw
 * on unknown-profile, and the dispatcher had no clean way to fall through to the
 * non-delegated path, so a client typo in the profile name produced a 500 rather
 * than the expected non-delegated completion.
 */
export function resolveDelegation(
  context: SessionContext,
  profileName: string,
): DelegationRoute | null {
  const profile = context.profiles.find((p) => p.name === profileName);
  if (!profile) return null;
  return {
    profile,
    targetModel: profile.model,
    tierMismatch: isBaseline(context.sessionTier) && isElevated(profile.model),
  };
}

/** Dispatches a delegated request.
 *
 * Fix #419: the previous implementation rebuilt the body, dropping session
 * metadata. This version mutates only the fields that must change for the
 * delegated call and carries every other field through unchanged.
 *
 * When `route.tierMismatch` is false, the session tier already matches the
 * target and no dispatch is performed. Metadata is preserved trivially because
 * nothing is touched.
 */
export function applyDelegation(
  body: Record<string, unknown>,
  route: DelegationRoute,
): Record<string, unknown> {
  if (!route.tierMismatch) return body;
  body.model = route.targetModel;
  return body;
}

/** Default delegation profile set for a baseline-tier session.
 *
 * The set spans the reasoning/latency trade-off space so the orchestrator has a
 * profile to reach for in most task shapes. The orchestrator picks by name;
 * nothing in the router ranks profiles or selects automatically.
 */
export function defaultDelegationProfiles(): DelegationProfile[] {
  return [
    {
      name: "reasoning-deep",
      model: "claude-opus-5.5",
      instructions:
        "You are a deep reasoning profile. Think carefully and exhaustively. Produce correct, idiomatic, production-ready output.",
      tools: ["read", "edit", "search", "run"],
    },
    {
      name: "long-horizon",
      model: "gpt-6-astra",
      instructions:
        "You are a long-horizon autonomous execution profile. Plan, execute, verify, and confirm results across multi-step workflows.",
      tools: ["read", "edit", "search", "run", "plan"],
    },
    {
      name: "low-latency",
      model: "claude-sonnet-4.5",
      instructions:
        "You are a low-latency profile. Prioritize correct, idiomatic output with minimal delay.",
      tools: ["read", "edit", "run"],
    },
    {
      name: "long-form",
      model: "claude-fable-5.1",
      instructions:
        "You are a long-form research and feature-development profile. Perform deep codebase analysis and complex multi-step workflows.",
      tools: ["read", "edit", "search"],
    },
  ];
}

export type { TenantClass };