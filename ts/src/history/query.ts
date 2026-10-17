/**
 * Query interface for the history store.
 *
 * Provides read-only access to historical records with support for
 * filtering by time range, sorting, and aggregation.
 *
 * All queries are performed on the in-memory replay (the canonical snapshot)
 * and return results as arrays of Record-like objects.
 *
 * Usage:
 *   const records = await query.get_all();
 *   const recent = await query.get_after(timestamp);
 *   const by_type = await query.filter_by_kind(kind);
 */

// --- Types ----------------------------------------------------------------
import { Record, RecordKind, Capacity, StateEntry } from "./codec";

export type QueryResult = Record[];

export type FilterByKind = RecordKind;

export type TimeRange = { start: number; end: number };

export type SortBy = "timestamp" | "boot_id" | "capacity" | "value" | "kind";

export type QueryParams = {
	start?: number;
	end?: number;
	kind?: RecordKind;
	sortBy?: SortBy;
	limit?: number;
}

// --- Public API ----------------------------------------------------------

export async function get_all(
	store: HistoryStore,
	params: QueryParams = {},
): Promise<QueryResult> {
	// Fetch all records from the replay
	// Sort by timestamp descending (newest first)
	// Return as array of Record
}

export async function get_after(
	store: HistoryStore,
	param: TimeRange,
): Promise<QueryResult> {
	// Return records with timestamp >= param.end (or > param.start)
}

export async function filter_by_kind(
	store: HistoryStore,
	kind: RecordKind,
): Promise<QueryResult> {
	// Filter records where kind matches
}

export async function sort_by(
	store: HistoryStore,
	param: QueryParams,
): Promise<QueryResult> {
	// Sort records by the specified field
}

export async function limit(
	store: HistoryStore,
	param: QueryParams,
	limit: number,
): Promise<QueryResult> {
	// Apply limit to the result set
}
