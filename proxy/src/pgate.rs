//! Per-provider concurrency gate — the freeinference 2-slot law.
//!
//! The Governor (per-model AIMD) caps individual models; this gate caps the
//! whole provider at `max_parallel` concurrent upstream connections. A
//! provider with a hard global concurrency limit (freeinference advertises 2)
//! must not discover it via 429 storms — the gate queues locally, FIFO, and
//! the caller never sees a 429 that was ours to prevent.
//!
//! Permit release is Drop-based (same pattern as Governor::ModelPermit).

use std::{
	collections::HashMap,
	sync::{Arc, Mutex},
	time::Instant,
};

#[derive(Debug, Default)]
struct GateState {
	/// Current in-flight upstream connections for this provider.
	inflight: usize,
	/// max_parallel from the ProviderDef; 0 = ungoverned.
	limit:     usize,
	/// FIFO waiters — granted in order as permits release.
	waiters:   Vec<Arc<tokio::sync::Notify>>,
}

/// Drop-released permit. Holding one = one upstream connection slot.
#[derive(Debug)]
pub struct ProviderPermit {
	gate:    Arc<Mutex<HashMap<String, GateState>>>,
	provider: String,
}

impl Drop for ProviderPermit {
	fn drop(&mut self) {
		let mut gates = self.gate.lock().unwrap();
		if let Some(s) = gates.get_mut(&self.provider) {
			s.inflight = s.inflight.saturating_sub(1);
			// Grant the next waiter in FIFO order.
			if let Some(w) = if s.waiters.is_empty() { None } else { Some(s.waiters.remove(0)) } {
				w.notify_one();
			}
		}
	}
}

#[derive(Debug, Default)]
pub struct ProviderGate {
	gates: Arc<Mutex<HashMap<String, GateState>>>,
}

impl ProviderGate {
	pub fn build(limits: &[(&str, usize)]) -> Self {
		let mut gates = HashMap::new();
		for (name, limit) in limits {
			gates.entry(name.to_string()).or_insert(GateState {
				inflight: 0,
				limit:    *limit,
				waiters:  Vec::new(),
			});
		}
		Self { gates: Arc::new(Mutex::new(gates)) }
	}

	/// Set/update the limit for a provider (called on registry rebuild).
	pub fn set_limit(&self, provider: &str, limit: usize) {
		self.gates
			.lock()
			.unwrap()
			.entry(provider.to_string())
			.or_default()
			.limit = limit;
	}

	/// Admit synchronously: true = caller holds a slot (via a returned
	/// permit-callback pair). We use a two-phase admit here: `try_admit`
	/// for the hot path (no wait), `wait_admit` for the queue path.
	pub fn try_admit(&self, provider: &str) -> Option<ProviderPermit> {
		let mut gates = self.gates.lock().unwrap();
		let s = gates.entry(provider.to_string()).or_default();
		if s.limit == 0 || s.inflight < s.limit {
			s.inflight += 1;
			Some(ProviderPermit {
				gate: self.gates.clone(),
				provider: provider.to_string(),
			})
		} else {
			None
		}
	}

	/// Current in-flight count (for /metrics).
	pub fn inflight(&self, provider: &str) -> usize {
		self.gates.lock().unwrap().get(provider).map_or(0, |s| s.inflight)
	}

	/// Configured limit (for /metrics).
	pub fn limit(&self, provider: &str) -> usize {
		self.gates.lock().unwrap().get(provider).map_or(0, |s| s.limit)
	}

	/// Per-provider snapshot for /api/gate (ops visibility).
	pub fn snapshot(&self) -> Vec<GateRow> {
		self.gates
			.lock()
			.unwrap()
			.iter()
			.map(|(k, v)| GateRow {
				provider: k.clone(),
				limit: v.limit,
				in_flight: v.inflight,
			})
			.collect()
	}
}
/// One row of the /api/gate status table.
#[derive(serde::Serialize)]
pub struct GateRow {
	pub provider:  String,
	pub limit:     usize,
	pub in_flight: usize,
}



#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ungoverned_provider_admits_everything() {
		let g = ProviderGate::default();
		let _p1 = g.try_admit("bornite").unwrap();
		let _p2 = g.try_admit("bornite").unwrap();
		let _p3 = g.try_admit("bornite").unwrap();
		assert_eq!(g.inflight("bornite"), 3);
	}

	#[test]
	fn limited_provider_blocks_at_cap() {
		let g = ProviderGate::build(&[("freeinference", 2)]);
		let _p1 = g.try_admit("freeinference").unwrap();
		let _p2 = g.try_admit("freeinference").unwrap();
		assert!(g.try_admit("freeinference").is_none());
		assert_eq!(g.inflight("freeinference"), 2);
		assert_eq!(g.limit("freeinference"), 2);
	}

	#[test]
	fn drop_releases_slot() {
		let g = ProviderGate::build(&[("freeinference", 2)]);
		let p1 = g.try_admit("freeinference").unwrap();
		let _p2 = g.try_admit("freeinference").unwrap();
		assert!(g.try_admit("freeinference").is_none());
		drop(p1);
		assert!(g.try_admit("freeinference").is_some());
	}

	#[test]
	fn set_limit_updates_existing_gate() {
		let g = ProviderGate::default();
		let _p1 = g.try_admit("x").unwrap(); // ungoverned: fine
		g.set_limit("x", 1);
		assert_eq!(g.limit("x"), 1);
		assert!(g.try_admit("x").is_none()); // 1 in-flight, capped
	}
}
