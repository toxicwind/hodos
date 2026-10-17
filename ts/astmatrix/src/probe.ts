/**
 * astmatrix-ts — upstream issue probe.
 *
 * Periodically reads the state of anthropics/claude-code#43869. When the issue
 * is closed, the subagent-routing workaround is removal-eligible: the operator
 * gets a warning and the attestation store becomes the audit surface for
 * verifying that no dispatch depended on the workaround after the close.
 *
 * The probe is read-only. It hits the public GitHub API once per interval
 * (default 24h) and caches the result. If the API is unreachable or rate-limits,
 * the previous state is retained and the probe retries on the next interval — a
 * probe failure must never change dispatch behaviour.
 */

/** The upstream issue this workaround tracks. */
export const TRACKED_ISSUE = "anthropics/claude-code#43869";

export const TRACKED_ISSUE_URL =
  "https://api.github.com/repos/anthropics/claude-code/issues/43869";

/** Default probe interval: one API call per day. */
export const DEFAULT_PROBE_INTERVAL_SECS = 24 * 60 * 60;

/** Probe state. */
export type IssueState =
  | { kind: "open" }
  | { kind: "closed"; closedAt: string | null }
  | { kind: "unknown" };

export const IssueOpen: IssueState = { kind: "open" };
export const IssueUnknown: IssueState = { kind: "unknown" };

/**
 * Is the workaround removal-eligible?
 *
 * Only a confirmed close counts. `unknown` must never read as eligible, or an
 * API hiccup would tell an operator to delete a workaround on false evidence.
 */
export function isRemovalEligible(state: IssueState): boolean {
  return state.kind === "closed";
}

/**
 * Maps a GitHub issue payload onto an {@link IssueState}.
 *
 * An unrecognised `state` string is `unknown`, not `open`: an API change must
 * not be read as "still broken".
 */
export function classifyIssueState(
  state: string,
  closedAt: string | null = null,
): IssueState {
  if (state === "closed") return { kind: "closed", closedAt };
  if (state === "open") return IssueOpen;
  return IssueUnknown;
}

/** Cached probe result, gated by an interval. */
export class ProbeCache {
  private state: IssueState = IssueUnknown;
  private lastCheck: number | null = null;
  private readonly intervalMs: number;

  constructor(intervalSecs: number = DEFAULT_PROBE_INTERVAL_SECS) {
    this.intervalMs = Math.max(0, intervalSecs) * 1000;
  }

  getState(): IssueState {
    return this.state;
  }

  /** Whether the interval has elapsed since the last probe attempt. */
  isDue(now: number = Date.now()): boolean {
    return this.lastCheck === null || now - this.lastCheck >= this.intervalMs;
  }

  /**
   * Runs the probe if the interval has elapsed. Safe to call from any request
   * path; the interval gate keeps it to one API call per interval.
   */
  async maybeProbe(
    client: CopilotClient,
    now: number = Date.now(),
  ): Promise<void> {
    if (!this.isDue(now)) return;

    let next: IssueState | null = null;
    try {
      next = await this.fetch();
    } catch {
      next = null;
    }

    // Stamp the attempt even on failure: a rate-limited or unreachable API must
    // not turn every subsequent request into another probe attempt.
    this.lastCheck = now;

    if (!next) return;

    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (!changed) return;

    if (isRemovalEligible(next)) {
      console.warn(
        `[probe] ${TRACKED_ISSUE} closed (${next.kind === "closed" ? next.closedAt : "?"}) — ` +
          "the subagent-routing workaround is removal-eligible; audit attestation " +
          "records written after this timestamp",
      );
    } else if (next.kind === "open") {
      console.log(`[probe] ${TRACKED_ISSUE} open`);
    }
  }

  private async fetch(): Promise<IssueState | null> {
    const resp = await fetch(TRACKED_ISSUE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "astmatrix-ts-probe",
      },
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { state?: string; closed_at?: string };
    return classifyIssueState(body.state ?? "", body.closed_at ?? null);
  }
}

type CopilotClient = { host(): Promise<unknown> };