//! Exports:
//! - Hypothesis: one retained decoder sequence and its native evidence.
//! - Alternative/OptionText: a transcript span and beam-relative textual options.
//! - align: align retained sequences without inventing alternatives.
//! - Transcript/TranscriptState: versioned stable history and mutable live segment.
//! - inline_text: format uncertainty spans without losing insertion boundaries.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hypothesis {
    pub text: String,
    pub tokens: Vec<String>,
    pub timestamps: Vec<f32>,
    pub score: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionText {
    pub text: String,
    /// Relative support inside the surviving beam, not calibrated confidence.
    pub confidence: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alternative {
    pub start: usize,
    pub end: usize,
    pub options: Vec<OptionText>,
}

pub fn align(hypotheses: &[Hypothesis]) -> Result<(String, Vec<Alternative>), String> {
    if hypotheses.is_empty() {
        return Err("Decoder returned no retained hypotheses".into());
    }
    if hypotheses.len() > 64 || hypotheses.iter().any(|h| !h.score.is_finite()) {
        return Err("Invalid decoder hypothesis count or score".into());
    }
    let best = hypotheses.iter().max_by(|a, b| a.score.total_cmp(&b.score)).unwrap();
    let words: Vec<&str> = best.text.split_whitespace().collect();
    if words.len() > 512 {
        return Err("Live segment exceeds the alignment word budget".into());
    }
    let text = words.join(" ");
    let mut aligned = Vec::new();
    let mut intervals = Vec::new();
    let total: f64 = hypotheses.iter().map(|h| (h.score - best.score).exp()).sum();
    for hypothesis in hypotheses {
        let candidate: Vec<&str> = hypothesis.text.split_whitespace().collect();
        if candidate.len() > 512 {
            return Err("Live hypothesis exceeds the alignment word budget".into());
        }
        let projection = WordAlignment::new(&words, &candidate);
        intervals.extend(projection.changes.iter().copied());
        aligned.push((projection, (hypothesis.score - best.score).exp() / total));
    }
    intervals.sort_unstable();
    let mut regions: Vec<(usize, usize)> = Vec::new();
    for (start, end) in intervals {
        if let Some(previous) = regions.last_mut() {
            // Adjacent edits remain one phrase, not independently mixable words.
            if start <= previous.1 {
                previous.1 = previous.1.max(end);
                continue;
            }
        }
        regions.push((start, end));
    }
    let mut starts = Vec::new();
    let mut offset = 0;
    for word in &words {
        starts.push(offset);
        offset += word.encode_utf16().count() + 1;
    }
    starts.push(text.encode_utf16().count());
    let mut alternatives = Vec::new();
    for (start, end) in regions {
        let mut support: BTreeMap<String, f64> = BTreeMap::new();
        for (projection, mass) in &aligned {
            *support.entry(projection.phrase(start, end)).or_default() += mass;
        }
        let mut options: Vec<OptionText> = support.into_iter()
            .filter(|(_, mass)| *mass >= 0.1)
            .map(|(text, confidence)| OptionText { text, confidence })
            .collect();
        options.sort_by(|a, b| b.confidence.total_cmp(&a.confidence).then(a.text.cmp(&b.text)));
        options.truncate(3);
        if options.len() < 2 { continue; }
        alternatives.push(Alternative {
            start: starts[start],
            end: if end > start {
                starts[end - 1] + words[end - 1].encode_utf16().count()
            } else { starts[start] },
            options,
        });
    }
    Ok((text, alternatives))
}

struct WordAlignment {
    before: Vec<Vec<String>>,
    at: Vec<Option<String>>,
    changes: Vec<(usize, usize)>,
}

impl WordAlignment {
    fn new(base: &[&str], candidate: &[&str]) -> Self {
        let width = candidate.len() + 1;
        let mut costs = vec![0_usize; (base.len() + 1) * width];
        for i in 0..=base.len() { costs[i * width] = i; }
        for j in 0..width { costs[j] = j; }
        for i in 1..=base.len() {
            for j in 1..width {
                costs[i * width + j] = (
                    costs[(i - 1) * width + j - 1] + usize::from(base[i - 1] != candidate[j - 1])
                ).min(costs[(i - 1) * width + j] + 1)
                    .min(costs[i * width + j - 1] + 1);
            }
        }
        let mut result = Self {
            before: vec![Vec::new(); base.len() + 1],
            at: vec![None; base.len()],
            changes: Vec::new(),
        };
        let (mut i, mut j) = (base.len(), candidate.len());
        while i > 0 || j > 0 {
            if i > 0 && j > 0 && costs[i * width + j]
                == costs[(i - 1) * width + j - 1] + usize::from(base[i - 1] != candidate[j - 1]) {
                result.at[i - 1] = Some(candidate[j - 1].into());
                if base[i - 1] != candidate[j - 1] { result.changes.push((i - 1, i)); }
                i -= 1;
                j -= 1;
            } else if i > 0 && costs[i * width + j] == costs[(i - 1) * width + j] + 1 {
                result.changes.push((i - 1, i));
                i -= 1;
            } else {
                result.before[i].push(candidate[j - 1].into());
                result.changes.push((i, i));
                j -= 1;
            }
        }
        for inserted in &mut result.before { inserted.reverse(); }
        result
    }

    fn phrase(&self, start: usize, end: usize) -> String {
        let mut words: Vec<&str> = self.before[start].iter().map(String::as_str).collect();
        for i in start..end {
            if let Some(word) = &self.at[i] { words.push(word); }
            words.extend(self.before[i + 1].iter().map(String::as_str));
        }
        words.join(" ")
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub session_id: String,
    pub revision: u64,
    pub segment: u32,
    pub is_final: bool,
    pub stable_text: String,
    pub unstable_text: String,
    pub alternatives: Vec<Alternative>,
    /// Complete retained paths for this segment, not just the displayed options.
    pub hypotheses: Vec<Hypothesis>,
    pub inline_text: String,
}

/// Owns committed segments only; the native decoder owns the live beam.
#[derive(Default)]
pub struct TranscriptState {
    history: String,
    history_alternatives: Vec<Alternative>,
    revision: u64,
    segment: u32,
}

impl TranscriptState {
    pub fn update(&mut self, session_id: &str, hypotheses: Vec<Hypothesis>, final_segment: bool) -> Result<Transcript, String> {
        let (live, mut alternatives) = align(&hypotheses)?;
        let prefix = if self.history.is_empty() { String::new() } else if live.is_empty() {
            self.history.clone()
        } else { format!("{} ", self.history) };
        let offset = prefix.encode_utf16().count();
        for alternative in &mut alternatives {
            alternative.start += offset;
            alternative.end += offset;
        }
        let full = format!("{prefix}{live}");
        let stable_length = if final_segment { live.len() } else {
            let candidates: Vec<Vec<&str>> = hypotheses.iter().map(|h| h.text.split_whitespace().collect()).collect();
            let complete = candidates.iter().map(|words| words.len().saturating_sub(1)).min().unwrap_or(0);
            let shared = (0..complete).take_while(|index| {
                candidates.iter().all(|words| words[*index] == candidates[0][*index])
            }).count();
            let shared_text = candidates[0][..shared].join(" ");
            if shared_text.is_empty() { 0 } else { shared_text.len() + usize::from(shared_text.len() < live.len()) }
        };
        let stable_text = format!("{prefix}{}", &live[..stable_length]);
        let unstable_text = live[stable_length..].to_owned();
        let all_alternatives: Vec<Alternative> = self.history_alternatives.iter().cloned().chain(alternatives.iter().cloned()).collect();
        self.revision += 1;
        let update = Transcript {
            session_id: session_id.into(), revision: self.revision, segment: self.segment,
            is_final: final_segment, stable_text, unstable_text,
            inline_text: inline_text(&full, &all_alternatives),
            alternatives: all_alternatives, hypotheses,
        };
        if final_segment {
            self.history = full;
            self.history_alternatives.extend(alternatives);
            self.segment += 1;
        }
        Ok(update)
    }
}

pub fn inline_text(text: &str, alternatives: &[Alternative]) -> String {
    let utf16: Vec<u16> = text.encode_utf16().collect();
    let mut result = String::new();
    let mut cursor = 0;
    for alternative in alternatives {
        result.push_str(&String::from_utf16_lossy(&utf16[cursor..alternative.start]));
        let insertion = alternative.start == alternative.end;
        if insertion && result.chars().last().is_some_and(|c| !c.is_whitespace()) { result.push(' '); }
        result.push('[');
        result.push_str(&alternative.options.iter().map(|option| option.text.as_str()).collect::<Vec<_>>().join("/"));
        result.push(']');
        if insertion && alternative.end < utf16.len() { result.push(' '); }
        cursor = alternative.end;
    }
    result.push_str(&String::from_utf16_lossy(&utf16[cursor..]));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hypothesis(text: &str, mass: f64) -> Hypothesis {
        Hypothesis { text: text.into(), tokens: Vec::new(), timestamps: Vec::new(), score: mass.ln() }
    }

    fn options(alternative: &Alternative) -> Vec<&str> {
        alternative.options.iter().map(|option| option.text.as_str()).collect()
    }

    #[test]
    fn retained_words_survive_as_ranked_alternatives() {
        let (text, alternatives) = align(&[
            hypothesis("i can add dirt", 0.6),
            hypothesis("i can at dirt", 0.4),
        ]).unwrap();
        assert_eq!(alternatives.len(), 1);
        assert_eq!(&text[alternatives[0].start..alternatives[0].end], "add");
        assert_eq!(options(&alternatives[0]), ["add", "at"]);
        assert!((alternatives[0].options[1].confidence - 0.4).abs() < 1e-8);
    }

    #[test]
    fn identical_text_paths_combine_support_before_filtering() {
        let (_, alternatives) = align(&[
            hypothesis("add dirt", 0.55),
            hypothesis("at dirt", 0.08),
            hypothesis("at dirt", 0.08),
            hypothesis("ad dirt", 0.25),
            hypothesis("and dirt", 0.04),
        ]).unwrap();
        assert_eq!(options(&alternatives[0]), ["add", "ad", "at"]);
        assert!((alternatives[0].options[2].confidence - 0.16).abs() < 1e-8);
    }

    #[test]
    fn insertions_and_deletions_keep_the_empty_option() {
        for hypotheses in [
            vec![hypothesis("quote dirt", 0.7), hypothesis("quote the dirt", 0.3)],
            vec![hypothesis("quote the dirt", 0.7), hypothesis("quote dirt", 0.3)],
        ] {
            let (_, alternatives) = align(&hypotheses).unwrap();
            assert_eq!(alternatives.len(), 1);
            let values = options(&alternatives[0]);
            assert!(values.contains(&""));
            assert!(values.contains(&"the"));
        }
    }

    #[test]
    fn multiword_changes_do_not_invent_phrase_combinations() {
        let (_, alternatives) = align(&[
            hypothesis("write a nice quote", 0.6),
            hypothesis("write an ice quote", 0.4),
        ]).unwrap();
        assert_eq!(alternatives.len(), 1);
        assert_eq!(options(&alternatives[0]), ["a nice", "an ice"]);
    }

    #[test]
    fn unicode_spans_use_browser_offsets() {
        let (text, alternatives) = align(&[
            hypothesis("🌟 add café", 0.6),
            hypothesis("🌟 at café", 0.4),
        ]).unwrap();
        let utf16: Vec<u16> = text.encode_utf16().collect();
        let span = &alternatives[0];
        assert_eq!(String::from_utf16(&utf16[span.start..span.end]).unwrap(), "add");
    }

    #[test]
    fn no_noise_options_or_nonfinite_scores() {
        assert!(align(&[hypothesis("add dirt", 0.95), hypothesis("at dirt", 0.05)]).unwrap().1.is_empty());
        assert!(align(&[hypothesis("add dirt", 0.0)]).is_err());
    }

    #[test]
    fn only_shared_complete_words_stabilise_and_endpoint_uncertainty_survives() {
        let mut state = TranscriptState::default();
        let hypotheses = vec![hypothesis("i want add", 0.6), hypothesis("i want at", 0.4)];
        let live = state.update("session", hypotheses.clone(), false).unwrap();
        assert_eq!(live.stable_text, "i want ");
        assert_eq!(live.unstable_text, "add");
        let final_segment = state.update("session", hypotheses, true).unwrap();
        assert!(final_segment.unstable_text.is_empty());
        let next = state.update("session", vec![hypothesis("dirt", 1.0)], false).unwrap();
        assert_eq!(next.stable_text, "i want add ");
        assert_eq!(next.unstable_text, "dirt");
        assert_eq!(next.alternatives.len(), final_segment.alternatives.len());
        assert!(next.revision > final_segment.revision);
    }

    #[test]
    fn an_unfinished_common_word_is_not_committed() {
        let mut state = TranscriptState::default();
        let partial = state.update("session", vec![hypothesis("i want at", 1.0)], false).unwrap();
        let extended = state.update("session", vec![hypothesis("i want attach", 1.0)], false).unwrap();
        assert_eq!(partial.stable_text, extended.stable_text);
        assert!(extended.unstable_text.contains("attach"));
    }
}
