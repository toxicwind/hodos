//! model_ref.rs — a typed model reference: (parent, provider, model).
//!
//! The router's model id is NOT a flat string. A model lives at
//!   `<parent>/<provider>/<model>[:<tier>][:<flavor>]`
//! e.g. `rhodochrosite/google/gemini-flash-tool-retrieval` or
//!      `rhodochrosite/nvidia/nemotron-3-ultra-550b-a55b:free`.
//! `rhodochrosite` is the ROUTER (a parent namespace), not a provider. Dropping the
//! provider (a bare `rhodochrosite/qwen3.6-35b`) is a PARSE ERROR — that is the whole
//! point: the old flat `rhodochrosite/<model>` form silently produced unknown-model
//! routing. Now the provider dimension is mandatory.
//!
//! Tier/flavor are part of the model, itself a small tuple. Everything renders
//! to the OpenAI `model` wire field as one string for ABI stability.

use std::fmt;
use std::str::FromStr;

/// Top-level namespace. Only `rhodochrosite` today; reserved so future router names
/// can be modelled without touching every consumer.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ParentRef(pub String);

impl Default for ParentRef {
    fn default() -> Self {
        ParentRef("rhodochrosite".to_string())
    }
}

/// The provider the model is served from (matches a `ProviderDef.name`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProviderRef(pub String);

/// Serving tier / flavor qualifiers on the model.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Qualifier {
    Tier(String),   // :free, :paid, :xlow..:xhigh
    Flavor(String), // :reasoning, :tool-search, :image, ...
}

/// The model itself: an id plus qualifiers (a small tuple, not one string).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Model {
    pub id: String,
    pub qualifiers: Vec<Qualifier>,
}

impl Model {
    pub fn tier(&self) -> Option<&str> {
        self.qualifiers.iter().find_map(|q| match q {
            Qualifier::Tier(t) => Some(t.as_str()),
            _ => None,
        })
    }
}

/// A fully-parented, provider-qualified model reference.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelRef {
    pub parent: ParentRef,
    pub provider: ProviderRef,
    pub model: Model,
}

impl ModelRef {
    pub fn wire(&self) -> String {
        let mut s = format!("{}/{}/{}", self.parent.0, self.provider.0, self.model.id);
        for q in &self.model.qualifiers {
            match q {
                Qualifier::Tier(t) => s.push_str(&format!(":{}", t)),
                Qualifier::Flavor(f) => s.push_str(&format!(":{}", f)),
            }
        }
        s
    }

    pub fn id_and_tier(&self) -> String {
        match self.model.tier() {
            Some(t) => format!("{}:{}", self.model.id, t),
            None => self.model.id.clone(),
        }
    }
}

/// Deterministic resolution: the provider the request should be routed to.
impl FromStr for ModelRef {
    type Err = ModelRefParseError;

    /// Requires `<parent>/<provider>/<model>...`. A bare `parent/model`
    /// (missing provider) is an error by design.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        // strip qualifiers first (they may be colon-separated after the model)
        let (body, qualifiers) = split_qualifiers(s);
        let mut parts = body.split('/');
        let parent = parts.next().ok_or(ModelRefParseError(s.to_string()))?;
        let provider = parts.next().ok_or(ModelRefParseError(s.to_string()))?;
        let id = parts.collect::<Vec<_>>().join("/");
        if id.is_empty() {
            return Err(ModelRefParseError(s.to_string()));
        }
        if parent.is_empty() || provider.is_empty() {
            return Err(ModelRefParseError(s.to_string()));
        }
        Ok(ModelRef {
            parent: ParentRef(parent.to_string()),
            provider: ProviderRef(provider.to_string()),
            model: Model { id, qualifiers },
        })
    }
}

fn split_qualifiers(s: &str) -> (&str, Vec<Qualifier>) {
    // model[:qual][:qual]; qualifiers begin at the first ':' after the last '/'
    match s.rfind('/') {
        Some(ls) => {
            let (head, tail) = s.split_at(ls + 1);
            let (id, qs) = match tail.find(':') {
                Some(i) => (&tail[..i], &tail[i..]),
                None => (tail, ""),
            };
            let quals = qs
                .split(':')
                .filter(|q| !q.is_empty())
                .map(|q| {
                    if q.starts_with("free") || q.starts_with("paid") || q.len() <= 5 {
                        Qualifier::Tier(q.to_string())
                    } else {
                        Qualifier::Flavor(q.to_string())
                    }
                })
                .collect();
            (format!("{}{}", head, id).leak(), quals)
        }
        None => {
            let (id, qs) = match s.find(':') {
                Some(i) => (&s[..i], &s[i..]),
                None => (s, ""),
            };
            let quals = qs
                .split(':')
                .filter(|q| !q.is_empty())
                .map(|q| Qualifier::Tier(q.to_string()))
                .collect();
            (id, quals)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRefParseError(pub String);

impl fmt::Display for ModelRefParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "not a 3-segment model ref; got '{}'. Expected 'rhodochrosite/<provider>/<model>[:tier]'",
            self.0
        )
    }
}

impl std::error::Error for ModelRefParseError {}

impl fmt::Display for ModelRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.wire())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_three_segment_form() {
        let r: ModelRef = "rhodochrosite/google/gemini-flash-tool-retrieval".parse().unwrap();
        assert_eq!(r.parent.0, "rhodochrosite");
        assert_eq!(r.provider.0, "google");
        assert_eq!(r.model.id, "gemini-flash-tool-retrieval");
        assert!(r.model.qualifiers.is_empty());
    }

    #[test]
    fn parses_tier_qualifier() {
        let r: ModelRef = "rhodochrosite/nvidia/nemotron-3-ultra-550b-a55b:free"
            .parse()
            .unwrap();
        assert_eq!(r.provider.0, "nvidia");
        assert_eq!(r.model.id, "nemotron-3-ultra-550b-a55b");
        assert_eq!(r.model.tier(), Some("free"));
        assert_eq!(r.id_and_tier(), "nemotron-3-ultra-550b-a55b:free");
    }

    #[test]
    fn renders_round_trip() {
        let s = "rhodochrosite/google/gemini-3.8-flash";
        let r: ModelRef = s.parse().unwrap();
        assert_eq!(r.wire(), s);
    }

    #[test]
    fn missing_provider_is_a_parse_error() {
        // rhodochrosite/qwen3.6-35b has NO provider segment -> invalid by design.
        let err = "rhodochrosite/qwen3.6-35b".parse::<ModelRef>();
        assert!(err.is_err());
    }

    #[test]
    fn bare_model_is_invalid() {
        assert!("qwen3.6-35b".parse::<ModelRef>().is_err());
    }
}
