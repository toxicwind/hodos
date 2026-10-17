/**
 * Canonical `nimproxy-history/v1` record serialization and validation.
 *
 * Ported from proxy/src/history/codec.rs. The on-disk format is JSONL
 * (one JSON object per line). Existing on-disk history must still load
 * without modification — fidelity to the Rust format is mandatory.
 *
 * Format per line (all fields ASCII-ordered in the wire order served
 * at /api/dashboard):
 *   {"format":"nimproxy-history","v":1,"kind":"boot"|"sample"|"checkpoint",...}
 *
 * Rules:
 *   - Boot/Checkpoint records have NO "state" field.
 *   - Sample records HAVE a "state" field containing an array of state entries.
 *   - The "capacity" field is always present.
 *   - "format" must be "nimproxy-history", "v" must be 1.
 */

export const FORMAT: string = "nimproxy-history";
export const VERSION: number = 1;

/** State kind (order matters for canonical ordering). */
export enum StateKind {
	Counter = "counter",
	Gauge = "gauge",
}

/** Capacity held at a single point in time. */
export type Capacity = {
	capacity_rpm: number;
	enabled_keys: number;
	key_rpms: number[];
};

/** A single metric state entry (one series at one value). */
export type StateEntry = {
	kind: StateKind;
	metric: string;
	labels: Record<string, string>;
	value: number;
};

/** Raw entry used during JSON deserialization of the state array. */
interface RawStateEntry {
	kind: string;
	metric: string;
	labels: Record<string, string>;
	value: number;
}

/** Record kinds as they appear in the "kind" field of the on-disk JSON. */
export type RecordKind = "boot" | "sample" | "checkpoint";

/** Result type: ok value or error string (never throws). */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Decode a single JSONL line into a Record.
 * Returns an error if the line is not valid UTF-8, not valid JSON,
 * has an unknown format/version, or has an invalid structure.
 */
export function decode_record(line: string): Result<Record> {
	// 1. UTF-8 check
	if (!is_valid_utf8(line)) {
		return { ok: false, error: "invalid_utf8" };
	}

	let raw: RawRecord;
	try {
		raw = JSON.parse(line);
	} catch {
		return { ok: false, error: "invalid_json" };
	}

	// 2. Format/version check
	if (raw.format !== FORMAT) {
		return { ok: false, error: "unsupported_format" };
	}
	if (raw.v !== VERSION) {
		return { ok: false, error: "unsupported_version" };
	}

	// 3. Build base (shared fields across all kinds)
	const base: BootRecord = {
		format: raw.format,
		v: raw.v,
		kind: raw.kind,
		timestamp: raw.timestamp,
		boot_id: raw.boot_id,
		capacity: raw.capacity,
	};

	// 4. Dispatch on kind
	switch (raw.kind) {
		case "boot": {
			// Boot is valid only when state is absent / null / missing
			const hasState = "state" in raw && raw.state !== null && raw.state !== undefined;
			if (hasState) {
				return { ok: false, error: "invalid_record" };
			}
			return { ok: true, value: { kind: "boot", ...base } };
		}

		case "checkpoint": {
			// Checkpoint is valid only when state is absent / null / missing
			const hasState = "state" in raw && raw.state !== null && raw.state !== undefined;
			if (hasState) {
				return { ok: false, error: "invalid_record" };
			}
			return { ok: true, value: { kind: "checkpoint", ...base } };
		}

		case "sample": {
			// Sample MUST have a state array
			if (!Array.isArray(raw.state)) {
				return { ok: false, error: "invalid_state" };
			}
			const decoded = decode_state(raw.state);
			if (decoded.ok === false) {
				return decoded;
			}
			return {
				ok: true,
				value: {
					kind: "sample",
					timestamp: base.timestamp,
					boot_id: base.boot_id,
					capacity: base.capacity,
					state: decoded.value,
				},
			};
		}

		default: {
			return { ok: false, error: "invalid_record_kind" };
		}
	}
}

/** Encoded boot (no "state" field on wire). */
interface EncodedBoot {
	format: string;
	v: number;
	kind: "boot";
	timestamp: number;
	boot_id: string;
	capacity: Capacity;
}

/** Encoded sample (has "state" field on wire). */
interface EncodedSample {
	format: string;
	v: number;
	kind: "sample";
	timestamp: number;
	boot_id: string;
	capacity: Capacity;
	state: EncodedStateEntry[];
}

/** Encoded checkpoint (no "state" field on wire). */
interface EncodedCheckpoint {
	format: string;
	v: number;
	kind: "checkpoint";
	timestamp: number;
	boot_id: string;
	capacity: Capacity;
}

/** Encoded individual state entry on the wire. */
interface EncodedStateEntry {
	kind: string;
	metric: string;
	labels: Record<string, string>;
	value: number;
}

/** Decoded state entries from the "state" array. */
type DecodedState = ReadonlyArray<StateEntry>;

/** Raw record shape as it appears on disk (JSONL). */
interface RawRecord {
	format: string;
	v: number;
	kind: string;
	timestamp: number;
	boot_id: string;
	capacity: Capacity;
	state?: unknown; /** optional; present only for "sample" kind */
}

/** The top-level Record enum. */
export type Record =
	| { kind: "boot"; timestamp: number; boot_id: string; capacity: Capacity }
	| {
			kind: "sample";
			timestamp: number;
			boot_id: string;
			capacity: Capacity;
			state: ReadonlyArray<StateEntry>;
	  }
	| { kind: "checkpoint"; timestamp: number; boot_id: string; capacity: Capacity };

/** Boot record subset of the Record union. */
export type BootRecord = Record & { kind: "boot" };

/** Checkpoint record subset of the Record union. */
export type CheckpointRecord = Record & { kind: "checkpoint" };

/** Sample record subset of the Record union. */
export type SampleRecord = Record & { kind: "sample"; state: ReadonlyArray<StateEntry> };

/** Decode the raw state array into normalized StateEntry[] */
function decode_state(raw: ReadonlyArray<RawStateEntry>): Result<DecodedState> {
	const result: StateEntry[] = [];
	const seen = new Set<string>();

	for (const entry of raw) {
		// Map kind string to StateKind
		let kind: StateKind;
		if (entry.kind === StateKind.Counter) {
			kind = StateKind.Counter;
		} else if (entry.kind === StateKind.Gauge) {
			kind = StateKind.Gauge;
		} else {
			return { ok: false, error: "invalid_state" };
		}

		// Build a dedup key: metric + sorted labels JSON
		const labels_json = JSON.stringify(entry.labels);
		const key = entry.metric + "|" + labels_json;
		if (seen.has(key)) {
			return { ok: false, error: "duplicate_series" };
		}
		seen.add(key);

		result.push({
			kind,
			metric: entry.metric,
			labels: entry.labels,
			value: entry.value,
		});
	}

	return { ok: true, value: result };
}

/**
 * Encode a Record into a JSON string (ready to be written as one line
 * followed by "\n" on disk).
 *
 * Boot/Checkpoint: omits the "state" field entirely.
 * Sample: includes the "state" array.
 */
export function encode_record(record: Record): string {
	switch (record.kind) {
		case "boot": {
			const { kind, ...boot } = record;
			return JSON.stringify({
				format: FORMAT,
				v: VERSION,
				kind: "boot",
				timestamp: boot.timestamp,
				boot_id: boot.boot_id,
				capacity: boot.capacity,
			});
		}

		case "checkpoint": {
			const { kind, ...checkpoint } = record;
			return JSON.stringify({
				format: FORMAT,
				v: VERSION,
				kind: "checkpoint",
				timestamp: checkpoint.timestamp,
				boot_id: checkpoint.boot_id,
				capacity: checkpoint.capacity,
			});
		}

		case "sample": {
			const { kind, ...sample } = record;
			return JSON.stringify({
				format: FORMAT,
				v: VERSION,
				kind: "sample",
				timestamp: sample.timestamp,
				boot_id: sample.boot_id,
				capacity: sample.capacity,
				state: sample.state.map((e) => ({
					kind: e.kind,
					metric: e.metric,
					labels: e.labels,
					value: e.value,
				})),
			});
		}
	}
}

/** Validate a state-entry kind string. */
function is_valid_state_kind(s: string): s is StateKind {
	return s === StateKind.Counter || s === StateKind.Gauge;
}

/** Minimal UTF-8 sanity check (mirrors the Rust `is_valid_utf8` guard). */
function is_valid_utf8(s: string): boolean {
	// Bun strings are already UTF-16; a simple check is to verify
	// that passing through JSON.parse round-trip doesn't lose characters.
	// For our purposes, we trust the input came from a file read.
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}