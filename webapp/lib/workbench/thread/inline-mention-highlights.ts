/*
 * Exports:
 * - InlineMentionCandidate: suggestion-ready skill or file target used by inline mention matching. Keywords: composer, questionnaire, mentions, suggestions.
 * - InlineMentionFileCandidateInput: project file input with optional ignored metadata. Keywords: file mention, gitignore, candidate.
 * - InlineMentionHighlight: resolved token range and target metadata for editor highlights. Keywords: highlight, token, skill, file.
 * - InlineMentionHighlightSources: grouped skill and file candidates for reusable mention resolution. Keywords: source, resolver, popup.
 * - InlineMentionSuggestion: active caret suggestion candidate with replacement range. Keywords: autocomplete, popup, mention.
 * - buildInlineMentionCandidates: convert loaded skills and project files into suggestion-ready candidates. Keywords: skills, files, source.
 * - buildInlineMentionHighlights: resolve unambiguous /skill and #file tokens in plaintext. Keywords: parser, highlighter, plaintext.
 * - buildInlineMentionSuggestions: rank caret-local skill or file suggestions. Keywords: autocomplete, caret, ranking.
 */

import type { WorkbenchSkillSummary } from "../../types";

export type InlineMentionCandidateKind = "skill" | "file";

export interface InlineMentionCandidate {
  aliases: string[];
  description: string;
  isExcluded?: boolean;
  kind: InlineMentionCandidateKind;
  label: string;
  path: string;
}

export interface InlineMentionFileCandidateInput {
  isIgnored?: boolean;
  path: string;
}

export interface InlineMentionHighlight {
  columnNumber?: number | null;
  end: number;
  kind: InlineMentionCandidateKind;
  label: string;
  lineNumber?: number | null;
  path: string;
  start: number;
  text: string;
  title: string;
}

export interface InlineMentionHighlightSources {
  candidates: InlineMentionCandidate[];
}

export interface InlineMentionSuggestion {
  candidate: InlineMentionCandidate;
  end: number;
  marker: "/" | "#";
  query: string;
  replacementText: string;
  start: number;
}

interface ParsedInlineMentionToken {
  end: number;
  kind: InlineMentionCandidateKind;
  marker: "/" | "#";
  rawValue: string;
  start: number;
}

const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)}\]]+$/;
const DEFAULT_INLINE_MENTION_SUGGESTION_LIMIT = 12;
const BROAD_FILE_SUGGESTION_LIMIT = 36;

function normalizeMentionPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function normalizeComparableValue(value: string) {
  return normalizeMentionPath(value).toLocaleLowerCase();
}

function getSkillDirectoryAlias(skill: WorkbenchSkillSummary) {
  const match = /^(?:\.agents\/)?skills\/([^/]+)\/SKILL\.md$/i.exec(normalizeMentionPath(skill.relativePath));
  return match?.[1] ?? "";
}

export function buildInlineMentionCandidates({
  files,
  skills,
}: {
  files: Array<string | InlineMentionFileCandidateInput>;
  skills: WorkbenchSkillSummary[];
}): InlineMentionHighlightSources {
  return {
    candidates: [
      ...skills.map((skill): InlineMentionCandidate => {
        const directoryAlias = getSkillDirectoryAlias(skill);
        return {
          aliases: Array.from(new Set([skill.name, directoryAlias].filter(Boolean))),
          description: skill.description,
          kind: "skill",
          label: skill.name,
          path: skill.path,
        };
      }),
      ...files.map((file): InlineMentionCandidate => {
        const filePath = typeof file === "string" ? file : file.path;
        return {
          aliases: [normalizeMentionPath(filePath)],
          description: "",
          isExcluded: typeof file === "string" ? false : Boolean(file.isIgnored),
          kind: "file",
          label: normalizeMentionPath(filePath),
          path: normalizeMentionPath(filePath),
        };
      }),
    ],
  };
}

function stripTrailingPunctuation(value: string) {
  return value.replace(TRAILING_PUNCTUATION_PATTERN, "");
}

function parseInlineMentionTokens(text: string): ParsedInlineMentionToken[] {
  const tokens: ParsedInlineMentionToken[] = [];
  const tokenPattern = /(^|\s)([/#])(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    const marker = match[2] as "/" | "#";
    const rawValue = match[3] ?? "";
    const leadingText = match[1] ?? "";
    const start = match.index + leadingText.length;
    const tokenText = `${marker}${rawValue}`;

    tokens.push({
      end: start + tokenText.length,
      kind: marker === "/" ? "skill" : "file",
      marker,
      rawValue,
      start,
    });
  }

  return tokens;
}

function parseActiveInlineMentionToken(text: string, caretOffset: number): ParsedInlineMentionToken | null {
  if (caretOffset < 0 || caretOffset > text.length) {
    return null;
  }

  const prefix = text.slice(0, caretOffset);
  const match = prefix.match(/(^|\s)([/#])(\S*)$/);
  if (!match) {
    return null;
  }

  const leadingText = match[1] ?? "";
  const marker = match[2] as "/" | "#";
  const rawValue = match[3] ?? "";
  const start = caretOffset - marker.length - rawValue.length;
  if (start > 0 && leadingText.length === 0) {
    return null;
  }

  return {
    end: caretOffset,
    kind: marker === "/" ? "skill" : "file",
    marker,
    rawValue,
    start,
  };
}

function resolveSkillMention(value: string, candidates: InlineMentionCandidate[]) {
  const normalizedValue = value.toLocaleLowerCase();
  const matches = candidates.filter((candidate) => (
    candidate.kind === "skill"
    && candidate.aliases.some((alias) => alias.toLocaleLowerCase() === normalizedValue)
  ));
  const uniquePaths = new Set(matches.map((match) => match.path));
  return uniquePaths.size === 1 && matches.length === 1 ? matches[0] : null;
}

function getFileMatches(value: string, candidates: InlineMentionCandidate[]) {
  const normalizedValue = normalizeComparableValue(value);
  return candidates.filter((candidate) => {
    if (candidate.kind !== "file") {
      return false;
    }

    const normalizedPath = normalizeComparableValue(candidate.path);
    return normalizedPath === normalizedValue || normalizedPath.endsWith(`/${normalizedValue}`);
  });
}

function parseFileMentionLocation(value: string) {
  const match = value.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (!match) {
    return {
      columnNumber: null,
      lineNumber: null,
      path: value,
    };
  }

  return {
    columnNumber: match[3] ? Number(match[3]) : null,
    lineNumber: Number(match[2]),
    path: match[1],
  };
}

function resolveFileMention(value: string, candidates: InlineMentionCandidate[]) {
  const parsedValue = parseFileMentionLocation(value);
  const exactMatches = getFileMatches(parsedValue.path, candidates).filter((candidate) => (
    normalizeComparableValue(candidate.path) === normalizeComparableValue(parsedValue.path)
  ));
  const exactPaths = new Set(exactMatches.map((match) => normalizeComparableValue(match.path)));
  if (exactPaths.size === 1 && exactMatches.length === 1) {
    return {
      candidate: exactMatches[0],
      columnNumber: parsedValue.columnNumber,
      lineNumber: parsedValue.lineNumber,
    };
  }

  const suffixMatches = getFileMatches(parsedValue.path, candidates);
  const suffixPaths = new Set(suffixMatches.map((match) => normalizeComparableValue(match.path)));
  return suffixPaths.size === 1 && suffixMatches.length === 1
    ? {
      candidate: suffixMatches[0],
      columnNumber: parsedValue.columnNumber,
      lineNumber: parsedValue.lineNumber,
    }
    : null;
}

function resolveToken(token: ParsedInlineMentionToken, sources: InlineMentionHighlightSources) {
  const rawCandidate = token.rawValue;
  const strippedCandidate = stripTrailingPunctuation(rawCandidate);
  const values = Array.from(new Set([rawCandidate, strippedCandidate].filter(Boolean)));

  for (const value of values) {
    const match = token.kind === "skill"
      ? resolveSkillMention(value, sources.candidates)
      : resolveFileMention(value, sources.candidates);
    if (match) {
      return {
        candidate: token.kind === "skill" ? match : match.candidate,
        columnNumber: token.kind === "skill" ? null : match.columnNumber,
        lineNumber: token.kind === "skill" ? null : match.lineNumber,
        value,
      };
    }
  }

  return null;
}

function getCandidateSearchValues(candidate: InlineMentionCandidate) {
  const path = normalizeMentionPath(candidate.path);
  const label = normalizeMentionPath(candidate.label);
  const basename = label.split("/").filter(Boolean).at(-1) ?? label;
  return Array.from(new Set([
    ...candidate.aliases.map(normalizeMentionPath),
    label,
    path,
    basename,
  ].filter(Boolean)));
}

function getPathSegments(value: string) {
  return normalizeMentionPath(value).split("/").filter(Boolean);
}

function getFuzzyMatchScore(query: string, value: string) {
  const normalizedQuery = normalizeComparableValue(query);
  const normalizedValue = normalizeComparableValue(value);
  if (!normalizedQuery) {
    return null;
  }

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let lastMatchIndex = -1;
  let gapScore = 0;
  for (let valueIndex = 0; valueIndex < normalizedValue.length && queryIndex < normalizedQuery.length; valueIndex += 1) {
    if (normalizedValue[valueIndex] !== normalizedQuery[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (lastMatchIndex !== -1) {
      gapScore += valueIndex - lastMatchIndex - 1;
    }
    lastMatchIndex = valueIndex;
    queryIndex += 1;
  }

  return queryIndex === normalizedQuery.length
    ? 80 + firstMatchIndex + gapScore
    : null;
}

function getFileSuggestionScore(query: string, candidate: InlineMentionCandidate) {
  const normalizedQuery = normalizeComparableValue(query);
  if (!normalizedQuery) {
    return null;
  }

  const normalizedPath = normalizeComparableValue(candidate.path);
  const basename = getPathSegments(candidate.path).at(-1) ?? normalizedPath;
  if (normalizedPath === normalizedQuery || normalizeComparableValue(basename) === normalizedQuery) {
    return 0;
  }
  if (normalizedPath.startsWith(normalizedQuery) || normalizeComparableValue(basename).startsWith(normalizedQuery)) {
    return 10;
  }
  if (getPathSegments(candidate.path).some((segment) => normalizeComparableValue(segment).startsWith(normalizedQuery))) {
    return 20;
  }
  if (normalizedPath.includes(normalizedQuery)) {
    return 40 + normalizedPath.indexOf(normalizedQuery);
  }

  return getFuzzyMatchScore(query, candidate.path);
}

function getSkillSuggestionScore(query: string, candidate: InlineMentionCandidate) {
  const normalizedQuery = normalizeComparableValue(query);
  if (!normalizedQuery) {
    return 3;
  }

  let bestScore: number | null = null;
  for (const value of getCandidateSearchValues(candidate)) {
    const normalizedValue = normalizeComparableValue(value);
    const score = normalizedValue === normalizedQuery
      ? 0
      : normalizedValue.startsWith(normalizedQuery)
        ? 1
        : normalizedValue.includes(normalizedQuery)
          ? 2
          : null;
    if (score === null) {
      continue;
    }

    bestScore = bestScore === null ? score : Math.min(bestScore, score);
  }

  return bestScore;
}

function allowsExcludedFileSuggestion(query: string, candidate: InlineMentionCandidate) {
  if (!candidate.isExcluded) {
    return true;
  }

  const normalizedQuery = normalizeComparableValue(query);
  if (!normalizedQuery) {
    return false;
  }

  const normalizedPath = normalizeComparableValue(candidate.path);
  const firstSegment = getPathSegments(candidate.path)[0] ?? "";
  return normalizedPath.startsWith(normalizedQuery)
    && (normalizedQuery.includes("/") || normalizedQuery.startsWith(".") || normalizedQuery.length >= Math.min(4, firstSegment.length));
}

function shouldShowFileSuggestions(query: string, scoredCount: number) {
  const normalizedQuery = normalizeComparableValue(query);
  if (!normalizedQuery) {
    return false;
  }

  if (normalizedQuery.includes("/") || normalizedQuery.startsWith(".")) {
    return true;
  }

  return normalizedQuery.length >= 3 || (normalizedQuery.length >= 2 && scoredCount <= BROAD_FILE_SUGGESTION_LIMIT);
}

function getSuggestionReplacementText(marker: "/" | "#", candidate: InlineMentionCandidate) {
  return `${marker}${candidate.kind === "skill" ? candidate.label : normalizeMentionPath(candidate.path)}`;
}

export function buildInlineMentionSuggestions(
  text: string,
  caretOffset: number | null,
  sources: InlineMentionHighlightSources,
  limit = DEFAULT_INLINE_MENTION_SUGGESTION_LIMIT,
): InlineMentionSuggestion[] {
  if (caretOffset === null) {
    return [];
  }

  const token = parseActiveInlineMentionToken(text, caretOffset);
  if (!token) {
    return [];
  }

  const scoredSuggestions = sources.candidates
    .filter((candidate) => candidate.kind === token.kind)
    .filter((candidate) => (
      token.kind !== "file" || allowsExcludedFileSuggestion(token.rawValue, candidate)
    ))
    .map((candidate) => ({
      candidate,
      score: token.kind === "file"
        ? getFileSuggestionScore(token.rawValue, candidate)
        : getSkillSuggestionScore(token.rawValue, candidate),
    }))
    .filter((entry): entry is { candidate: InlineMentionCandidate; score: number } => entry.score !== null);

  if (token.kind === "file" && !shouldShowFileSuggestions(token.rawValue, scoredSuggestions.length)) {
    return [];
  }

  return scoredSuggestions
    .sort((left, right) => (
      left.score - right.score
      || left.candidate.label.localeCompare(right.candidate.label, undefined, { sensitivity: "base" })
      || left.candidate.path.localeCompare(right.candidate.path, undefined, { sensitivity: "base" })
    ))
    .slice(0, limit)
    .map(({ candidate }) => ({
      candidate,
      end: token.end,
      marker: token.marker,
      query: token.rawValue,
      replacementText: getSuggestionReplacementText(token.marker, candidate),
      start: token.start,
    }));
}

export function buildInlineMentionHighlights(
  text: string,
  sources: InlineMentionHighlightSources,
): InlineMentionHighlight[] {
  const highlights: InlineMentionHighlight[] = [];
  for (const token of parseInlineMentionTokens(text)) {
    const resolution = resolveToken(token, sources);
    if (!resolution) {
      continue;
    }

    const end = token.start + token.marker.length + resolution.value.length;
    highlights.push({
      columnNumber: resolution.columnNumber,
      end,
      kind: resolution.candidate.kind,
      label: resolution.candidate.label,
      lineNumber: resolution.lineNumber,
      path: resolution.candidate.path,
      start: token.start,
      text: text.slice(token.start, end),
      title: resolution.candidate.kind === "skill"
        ? `Known skill: ${resolution.candidate.label}`
        : `Project file: ${resolution.candidate.path}`,
    });
  }

  return highlights;
}
