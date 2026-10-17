/**
 * astmatrix-ts — attestation for workaround dispatches.
 *
 * Every dispatch that goes through the upstream workaround
 * (anthropics/claude-code#43869) writes a record. The record is the evidence
 * trail that connects a dispatched request to the workaround that produced its
 * execution target. When the upstream issue closes, the record set is the audit
 * surface for verifying that the workaround can be removed and that no dispatch
 * depended on it after the close.
 *
 * Records are bounded in-memory and flushed to a JSONL file on rotation.
 */
import { appendFileSync } from "node:fs";

/** Outcome recorded when the mutation landed and verified. */
export const OUTCOME_APPLIED = "mutation-applied";
/** Outcome recorded when the body was not a JSON object. */
export const OUTCOME_SEALED_NOT_OBJECT = "sealed-not-an-object";
/** Outcome recorded when the post-mutation check disagreed. */
export const OUTCOME_SEALED_VERIFICATION = "sealed-verification-failed";
/** Outcome recorded when the tool call was not a delegation at all. */
export const OUTCOME_NOT_DELEGATED = "not-delegated";

/** Default in-memory bound on retained records. */
export const DEFAULT_ATTESTATION_CAPACITY = 4096;

/** One dispatch attestation. */
export interface AttestationRecord {
  /** Profile name the orchestrator selected. */
  profile: string;
  /** Model the profile pinned. */
  targetModel: string;
  /** Model the session was opened at. */
  sessionTier: string;
  /** One of the `OUTCOME_*` labels. */
  outcome: string;
  /** The upstream issue this workaround exists for. */
  upstreamIssue: string;
}

/**
 * Bounded ring of attestation records with an optional JSONL flush sink.
 *
 * Flushing is best-effort and never blocks dispatch: losing an audit row must
 * not cost a request.
 */
export class AttestationStore {
  private records: AttestationRecord[] = [];
  private readonly capacity: number;
  private readonly flushPath: string | null;

  constructor(
    capacity: number = DEFAULT_ATTESTATION_CAPACITY,
    flushPath: string | null = null,
  ) {
    this.capacity = Math.max(1, capacity);
    this.flushPath = flushPath;
  }

  /** Records one dispatch, rotating the oldest out when the ring is full. */
  record(rec: AttestationRecord): void {
    if (this.records.length >= this.capacity) {
      const oldest = this.records.shift();
      if (oldest && this.flushPath) this.appendJsonl(oldest);
    }
    this.records.push(rec);
  }

  /** Snapshot of the retained records, oldest first. */
  snapshot(): AttestationRecord[] {
    return this.records.slice();
  }

  /** Counts by outcome — the shape a diagnostics endpoint wants. */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.records) {
      out[r.outcome] = (out[r.outcome] ?? 0) + 1;
    }
    return out;
  }

  private appendJsonl(rec: AttestationRecord): void {
    if (!this.flushPath) return;
    try {
      // Appended synchronously: the flush happens on rotation (rare) and a
      // failed write must not surface on the dispatch path.
      appendFileSync(this.flushPath, JSON.stringify(rec) + "\n");
    } catch {
      // A sink that cannot be opened costs an audit row, not a request.
    }
  }
}

/**
 * Post-mutation verification: does the body's `model` equal `expected`?
 *
 * A false return means the body was sealed, the field was renamed, or a
 * concurrent writer changed the value between the insert and this read.
 */
export function targetAgreement(
  body: Record<string, unknown>,
  expected: string,
): boolean {
  return body["model"] === expected;
}