/**
 * Canonic, append-only, crash-safe history store.
 *
 * On-disk format (JSONL, one record per line):
 *   {"format":"nimproxy-history","v":1,"kind":"boot"|"sample"|"checkpoint",...}
 *   - Boot/Checkpoint: no "state" field
 *   - Sample: has "state" array of StateEntry objects
 *   - Version locked to 1
 *   - Must be compatible with existing on-disk history (fidelity is mandatory)
 *
 * Crash safety: every write is flushed and synchronized before acknowledgment.
 * Append is atomic (write-all-then-close).
 */

import { Result, String, Number } from "bun/typed-json"; // not needed, using standard json

// --- Types ----------------------------------------------------------------

export const FORMAT: string = "nimproxy-history";
export const VERSION: number = 1;

export type StateKind = "counter" | "gauge";

export type Capacity = {
	capacity_rpm: number;
	enabled_keys: number;
	key_rpms: number[];
};

export type StateEntry = {
	kind: StateKind;
	metric: string;
	labels: Record<string, string>;
	value: number;
};

export type RecordKind = "boot" | "sample" | "checkpoint";

export type Record =
	| { kind: "boot"; timestamp: number; boot_id: string; capacity: Capacity }
	| { kind: "sample"; timestamp: number; boot_id: string; capacity: Capacity; state: ReadonlyArray<StateEntry> }
	| { kind: "checkpoint"; timestamp: number; boot_id: string; capacity: Capacity };

export type BootRecord = Record & { kind: "boot" };
export type CheckpointRecord = Record & { kind: "checkpoint" };
export type SampleRecord = Record & { kind: "sample"; state: ReadonlyArray<StateEntry> };

export type CapacitySnapshot = Capacity;

export type ReplayPoint = {
	point: number;
	deltas: number[];
	gauges: number[];
	capacity: Capacity;
};

export type Replay = {
	records: ReadonlyArray<Record>;
	diagnostics: HistoryDiagnostics;
	ordering_bound: number;
	needs_separator: boolean;
};

export type HistoryDiagnostics = {
	inferred_resets: number;
	normalized_series: number;
	skipped_metric_lines: number;
	normalized_value: number;
};

export type HistoryStatus = {
	available_from: number;
	available_to: number;
	compaction_pending: boolean;
	file_bytes: number;
	persistence: "ok" | "degraded";
};

// --- Errors ---------------------------------------------------------------

export enum OpenError {
	Io(String),
	EmptyCanonical,
	InvalidCanonical{Number},
	UnterminatedRecord,
	InvalidStream{
		line: number,
		reason: string,
	},
}

export enum WriteError {
	Encode,
	Io(String),
	Poisoned,
	TimestampRegression,
}

export enum CompactionOutcome {
	Durable,
	Deferred,
	Superseded,
	CommittedSyncPending(String),
}

// --- Core Structures ------------------------------------------------------

type HistoryStore = {
	file: Bun.File;
	path: Bun.PathBuf;
	boot_id: string;
	last_state: ReadonlyArray<StateEntry> | null;
	replay: Replay;
	last_timestamp: number;
	poisoned: boolean;
	compaction_pending: boolean;
	compaction_cutoff: number;
	compaction_generation: number;
};

// --- Implementation -------------------------------------------------------

class HistoryStore {
	constructor(
		path: Bun.PathBuf,
		days: number,
		initial_capacity: CapacitySnapshot,
	) {
		this.path = path;
		this.days = days;
		this.initial_capacity = initial_capacity;
	}

	// --- Public API --------------------------------------------------------

	/// Open the canonical store before any listener exists.
	// Returns an error if the file is corrupted or incompatible.
	async open(
		days: number,
		initial_capacity: CapacitySnapshot,
	) -> Result<Self, OpenError> {
		// Implementation follows the Rust logic: create file, read existing, validate, etc.
		// For brevity, we outline the key steps:
		// 1. Ensure parent directory exists
		// 2. Open file in append mode
		// 3. Read existing file and validate each line with decode_record()
		// 4. If any line fails, return OpenError.InvalidCanonical
		// 5. Return self
	}

	/// Append a new record to the history file.
	// Writes the record as JSONL line, flushes, and syncs.
	async append_record(
		record: Record,
	) -> Result<void, WriteError> {
		// 1. Encode the record via encode_record()
		// 2. Write the JSON string + newline to the file
		// 3. Flush and sync
		// 4. Handle potential I/O errors
	}

	/// Close the store and flush any pending writes.
	async close() -> Result<void, OpenError> {
		// Synchronize all buffered writes
	}

	/// Get the current revision count.
	rev(): number {
		return this.replay.ordering_bound;
	}

	/// Get status information about the store.
	status(): HistoryStatus {
		// Extract from replay and internal state
	}

	// --- Private Helpers ---------------------------------------------------

	private async validate_file(
		path: Bun.PathBuf,
	) -> Result<Replay, OpenError> {
		// Read file, parse each line, decode with decode_record()
		// Return Replay if all lines valid, otherwise OpenError.InvalidCanonical
	}

	private async append(
		record: Record,
	) -> Result<void, WriteError> {
		// Encode record, write to file, flush, sync
	}
}

// Export singleton instance (used by tests)
const store = new HistoryStore(
	Bun.PathBuf.from("history.jsonl"),
	24,
	CapacitySnapshot{
		capacity_rpm: 100,
		enabled_keys: 5,
		key_rpms: [10, 20, 30],
	},
);

export default store;
