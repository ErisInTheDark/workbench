/*
 * Exports:
 * - SearchClause: one parsed positive or excluded word/phrase with its folded name tokens.
 * - parseSearchQuery: split a query into words, "quoted phrases" and -exclusions.
 * - foldSearchText: case- and accent-insensitive text, matching the narrative index tokenizer.
 * - SearchName/createSearchName: tokenised display name (title, path, label) with its relative weight.
 * - matchSearchName: best quality (0..1) of one clause against a candidate's names.
 * - searchCorrections: nearby vocabulary terms for a word that matched nothing.
 * - searchBodyQuality: map an FTS bm25 rank onto 0..1 evidence.
 * - rankSearchCandidate: combine per-clause evidence into a coverage-first score.
 * - searchExcerpt: compact preview of text centred on the first matched needle.
 */

export interface SearchClause {
  excluded: boolean;
  kind: "phrase" | "word";
  /** Folded clause text, as typed apart from case and accents. */
  value: string;
  /** Folded name tokens of the clause, split like names are. */
  tokens: readonly string[];
}

export interface SearchName {
  compact: string;
  initials: string;
  tokens: readonly string[];
  weight: number;
}

const MARKS = /\p{M}/gu;
const SEPARATORS = /[^\p{L}\p{N}]+/u;
const WORD_BOUNDARIES = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;
const BODY_WEIGHT = 0.7;
const BOTH_FIELDS_BONUS = 0.15;
const BODY_RANK_HALF_QUALITY = 4;
const TOGETHER_SHARE = 0.3;
const MAX_LIFT = 1.4;
const MAX_CORRECTIONS = 6;

export function foldSearchText(text: string) {
  return text.normalize("NFD").replace(MARKS, "").toLowerCase();
}

function nameTokens(text: string) {
  return text.normalize("NFD").replace(MARKS, "").split(SEPARATORS)
    .flatMap(part => part.split(WORD_BOUNDARIES))
    .filter(Boolean)
    .map(token => token.toLowerCase());
}

export function parseSearchQuery(query: string): SearchClause[] {
  const clauses: SearchClause[] = [];
  for (const match of query.matchAll(/(-?)"([^"]*)"?|(-?)(\S+)/gu)) {
    const phrase = match[2] !== undefined;
    const raw = (phrase ? match[2] : match[4])!.trim();
    const excluded = (phrase ? match[1] : match[3]) === "-";
    if (!raw || (!phrase && raw === "-")) continue;
    clauses.push({ excluded, kind: phrase ? "phrase" : "word", value: foldSearchText(raw), tokens: nameTokens(raw) });
  }
  return clauses;
}

/** Every search re-reads the same titles and paths, so their tokenised names are kept; the bound only caps churn. */
const NAME_CACHE_LIMIT = 50_000;
const nameCache = new Map<string, SearchName>();

export function createSearchName(text: string, options: { initials?: boolean; weight?: number } = {}): SearchName {
  const key = `${options.initials ? 1 : 0}|${options.weight ?? 1}|${text}`;
  const cached = nameCache.get(key);
  if (cached) return cached;
  const tokens = nameTokens(text);
  const name = Object.freeze({
    compact: tokens.join(""),
    initials: options.initials ? tokens.map(token => token[0]).join("") : "",
    tokens: Object.freeze(tokens),
    weight: options.weight ?? 1,
  });
  if (nameCache.size >= NAME_CACHE_LIMIT) nameCache.clear();
  nameCache.set(key, name);
  return name;
}

function matchToken(word: string, name: SearchName, corrections: ReadonlySet<string>) {
  const { tokens } = name;
  let best = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === word) return 1;
    if (token.startsWith(word)) best = Math.max(best, 0.75 + 0.2 * (word.length / token.length));
    else if (word.length > token.length && word.startsWith(token)) {
      // "searchdialog" spans the tokens of "SearchDialog".
      let joined = token;
      for (let next = index + 1; next < tokens.length && word.startsWith(joined); next += 1) {
        joined += tokens[next];
        if (joined === word) best = Math.max(best, 0.95);
        else if (joined.startsWith(word)) best = Math.max(best, 0.85);
      }
    }
    if (corrections.has(token)) best = Math.max(best, 0.6);
  }
  if (best === 0 && word.length >= 3 && name.compact.includes(word)) best = 0.5;
  if (best === 0 && word.length >= 2 && name.initials.length >= 2 && name.initials.startsWith(word)) best = 0.55;
  return best;
}

function matchRun(words: readonly string[], name: SearchName) {
  const { tokens } = name;
  const last = words.length - 1;
  for (let start = 0; start + last < tokens.length; start += 1) {
    if (!words.every((word, offset) => offset === last
      ? tokens[start + offset]!.startsWith(word) : tokens[start + offset] === word)) continue;
    return tokens[start + last] === words[last] ? 1 : 0.95;
  }
  return 0;
}

/** Name quality of one clause: exact tokens beat prefixes, which beat joined, inner, initial and corrected matches. */
export function matchSearchName(clause: SearchClause, names: readonly SearchName[], corrections: ReadonlySet<string> = new Set()) {
  if (!clause.tokens.length) return 0;
  let best = 0;
  for (const name of names) {
    let quality = clause.kind === "word" && clause.tokens.length === 1
      ? matchToken(clause.tokens[0]!, name, corrections)
      : matchRun(clause.tokens, name);
    if (!quality && clause.kind === "word" && clause.tokens.length > 1) {
      quality = 0.85 * Math.min(...clause.tokens.map(token => matchToken(token, name, corrections)));
    }
    best = Math.max(best, quality * name.weight);
  }
  return best;
}

function boundedEditDistance(left: string, right: string, limit: number) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let minimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + Number(left[row - 1] !== right[column - 1]),
      );
      minimum = Math.min(minimum, current[column]!);
    }
    if (minimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length]!;
}

/** Corrections only exist for words long enough that one or two edits still identify them. */
export function searchCorrections(word: string, candidates: Iterable<{ frequency: number; term: string }>) {
  if (word.length < 4 || !/^\p{L}+$/u.test(word)) return [];
  const limit = word.length >= 8 ? 2 : 1;
  const found = new Map<string, { distance: number; frequency: number }>();
  for (const { frequency, term } of candidates) {
    if (term === word || Math.abs(term.length - word.length) > limit) continue;
    const distance = boundedEditDistance(word, term, limit);
    if (distance > limit) continue;
    const known = found.get(term);
    found.set(term, { distance, frequency: Math.max(frequency, known?.frequency ?? 0) });
  }
  return [...found].sort(([, left], [, right]) => left.distance - right.distance || right.frequency - left.frequency)
    .slice(0, MAX_CORRECTIONS).map(([term]) => term);
}

/** bm25 ranks are negative; rarer terms in shorter messages rank further below zero. */
export function searchBodyQuality(rank: number) {
  const strength = Math.max(0, -rank);
  return strength / (strength + BODY_RANK_HALF_QUALITY);
}

/**
 * Every matched clause outranks any amount of quality, so candidates covering more of the query lead.
 * Quality blends name and body evidence per clause, plus a share for the whole query landing together:
 * all clauses in the name, or `together` (body quality of one message holding every clause).
 * Lift (1..1.4) carries freshness and project affinity.
 */
export function rankSearchCandidate(
  positives: readonly SearchClause[],
  evidence: readonly { body: number; name: number }[],
  options: { lift?: number; together?: number } = {},
) {
  let matched = 0;
  let quality = 0;
  let allInName = 1;
  for (const [index, clause] of positives.entries()) {
    const { body, name } = evidence[index]!;
    const clauseQuality = Math.min(1, Math.max(name, BODY_WEIGHT * body) + BOTH_FIELDS_BONUS * Math.min(name, body));
    allInName = Math.min(allInName, name);
    if (clauseQuality <= 0) {
      if (clause.kind === "phrase") return null;
      continue;
    }
    matched += 1;
    quality += clauseQuality;
  }
  if (!matched) return null;
  const together = Math.max(allInName, BODY_WEIGHT * (options.together ?? 0));
  const blended = (1 - TOGETHER_SHARE) * (quality / positives.length) + TOGETHER_SHARE * together;
  return matched + 0.99 * blended * (Math.min(MAX_LIFT, Math.max(1, options.lift ?? 1)) / MAX_LIFT);
}

export function searchExcerpt(text: string, needles: readonly string[], length = 180) {
  const compact = text
    .replace(/<\/?[a-z][\w-]*(?:\s[^<>]*)?\/?>/giu, " ")
    .replace(/#\[([^\]\n]+)\]/gu, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/gu, "$1")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gmu, "")
    .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gmu, " ")
    .replace(/[ \t]*\|[ \t]*/gu, " · ")
    .replace(/\*\*|__|`+/gu, "")
    .replace(/(?:[ \t]*·[ \t]*){2,}/gu, " · ")
    .replace(/^[ \t]*·[ \t]*|[ \t]*·[ \t]*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (compact.length <= length) return compact;
  const lower = compact.toLowerCase();
  const at = needles.reduce((best, needle) => {
    const index = needle ? lower.indexOf(needle) : -1;
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const window = Math.max(0, Math.min(Math.max(0, at) - Math.floor(length / 3), compact.length - length));
  // Start and end on word boundaries so the excerpt never opens or closes on half a word.
  const space = window > 0 ? compact.indexOf(" ", window) : -1;
  const start = space >= 0 && (at < 0 || space < at) ? space + 1 : window;
  const cut = Math.min(compact.length, start + length);
  const end = cut < compact.length && compact.lastIndexOf(" ", cut) > start ? compact.lastIndexOf(" ", cut) : cut;
  return `${start > 0 ? "... " : ""}${compact.slice(start, end).trim()}${end < compact.length ? " ..." : ""}`;
}
