/*
 * Exports:
 * - InlineMentionCandidate: suggestion-ready skill or file target used by inline mention matching. Keywords: composer, questionnaire, mentions, suggestions.
 * - InlineMentionHighlight: resolved token range and target metadata for editor highlights. Keywords: highlight, token, skill, file.
 * - InlineMentionHighlightSources: grouped skill and file candidates for reusable mention resolution. Keywords: source, resolver, popup.
 * - buildInlineMentionCandidates: convert loaded skills and project files into suggestion-ready candidates. Keywords: skills, files, source.
 * - buildInlineMentionHighlights: resolve unambiguous /skill and #file tokens in plaintext. Keywords: parser, highlighter, plaintext.
 */

import type { WorkbenchSkillSummary } from "../../types";

export type InlineMentionCandidateKind = "skill" | "file";

export interface InlineMentionCandidate {
  aliases: string[];
  description: string;
  kind: InlineMentionCandidateKind;
  label: string;
  path: string;
}

export interface InlineMentionHighlight {
  end: number;
  kind: InlineMentionCandidateKind;
  label: string;
  path: string;
  start: number;
  text: string;
  title: string;
}

export interface InlineMentionHighlightSources {
  candidates: InlineMentionCandidate[];
}

interface ParsedInlineMentionToken {
  end: number;
  kind: InlineMentionCandidateKind;
  marker: "/" | "#";
  rawValue: string;
  start: number;
}

const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)}\]]+$/;

function normalizeMentionPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function normalizeComparableValue(value: string) {
  return normalizeMentionPath(value).toLocaleLowerCase();
}

function getSkillDirectoryAlias(skill: WorkbenchSkillSummary) {
  const match = /^skills\/([^/]+)\/SKILL\.md$/i.exec(normalizeMentionPath(skill.relativePath));
  return match?.[1] ?? "";
}

export function buildInlineMentionCandidates({
  files,
  skills,
}: {
  files: string[];
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
      ...files.map((filePath): InlineMentionCandidate => ({
        aliases: [normalizeMentionPath(filePath)],
        description: "",
        kind: "file",
        label: normalizeMentionPath(filePath),
        path: normalizeMentionPath(filePath),
      })),
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

function resolveFileMention(value: string, candidates: InlineMentionCandidate[]) {
  const exactMatches = getFileMatches(value, candidates).filter((candidate) => (
    normalizeComparableValue(candidate.path) === normalizeComparableValue(value)
  ));
  const exactPaths = new Set(exactMatches.map((match) => normalizeComparableValue(match.path)));
  if (exactPaths.size === 1 && exactMatches.length === 1) {
    return exactMatches[0];
  }

  const suffixMatches = getFileMatches(value, candidates);
  const suffixPaths = new Set(suffixMatches.map((match) => normalizeComparableValue(match.path)));
  return suffixPaths.size === 1 && suffixMatches.length === 1 ? suffixMatches[0] : null;
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
        candidate: match,
        value,
      };
    }
  }

  return null;
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
      end,
      kind: resolution.candidate.kind,
      label: resolution.candidate.label,
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
