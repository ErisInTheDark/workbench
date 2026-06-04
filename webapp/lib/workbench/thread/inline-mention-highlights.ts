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
import {
  type WorkspaceFileLinkRoot,
  normalizeWorkbenchPath,
  resolveProjectFileLinkTarget,
} from "../markdown/markdown-links";

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
  cacheKey: string;
  candidates: InlineMentionCandidate[];
  fileCandidatePaths: readonly string[];
  threadCwdPath?: string;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
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
  explicitBoundary: boolean;
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

function getStringListCacheKey(values: readonly string[]) {
  let hash = 2_166_136_261;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return `${values.length}:${(hash >>> 0).toString(36)}`;
}

export function buildInlineMentionCandidates({
  files,
  threadCwdPath,
  projectRootPath,
  skills,
  workspaceRoots = [],
}: {
  files: Array<string | InlineMentionFileCandidateInput>;
  threadCwdPath?: string;
  projectRootPath?: string;
  skills: WorkbenchSkillSummary[];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}): InlineMentionHighlightSources {
  const fileCandidates = files.map((file): InlineMentionCandidate => {
    const filePath = typeof file === "string" ? file : file.path;
    return {
      aliases: [normalizeMentionPath(filePath)],
      description: "",
      isExcluded: typeof file === "string" ? false : Boolean(file.isIgnored),
      kind: "file",
      label: normalizeMentionPath(filePath),
      path: normalizeMentionPath(filePath),
    };
  });

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
      ...fileCandidates,
    ],
    cacheKey: [
      projectRootPath ?? "",
      threadCwdPath ?? "",
      workspaceRoots.map((root) => `${root.id}:${root.rootPath}`).join(";"),
      getStringListCacheKey(fileCandidates.map((candidate) => candidate.path)),
      getStringListCacheKey(skills.map((skill) => `${skill.name}\n${skill.path}\n${skill.relativePath}`)),
    ].join("|"),
    fileCandidatePaths: fileCandidates.map((candidate) => candidate.path),
    threadCwdPath,
    projectRootPath,
    workspaceRoots,
  };
}

function stripTrailingPunctuation(value: string) {
  return value.replace(TRAILING_PUNCTUATION_PATTERN, "");
}

function isInlineMentionBoundary(value: string | undefined) {
  return !value || /\s/.test(value);
}

function getLineEndIndex(text: string, start: number) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\r" || text[index] === "\n") {
      return index;
    }
  }

  return text.length;
}

function parseInlineMentionTokens(text: string): ParsedInlineMentionToken[] {
  const tokens: ParsedInlineMentionToken[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const marker = text[index];
    if ((marker !== "/" && marker !== "#") || !isInlineMentionBoundary(text[index - 1])) {
      continue;
    }

    if (marker === "/") {
      const match = /^\/(\S+)/.exec(text.slice(index));
      if (!match) {
        continue;
      }

      tokens.push({
        end: index + match[0].length,
        explicitBoundary: false,
        kind: "skill",
        marker,
        rawValue: match[1],
        start: index,
      });
      index += match[0].length - 1;
      continue;
    }

    if (text[index + 1] === "[") {
      const closeIndex = text.indexOf("]", index + 2);
      const lineEndIndex = getLineEndIndex(text, index + 2);
      if (closeIndex !== -1 && closeIndex <= lineEndIndex) {
        tokens.push({
          end: closeIndex + 1,
          explicitBoundary: true,
          kind: "file",
          marker,
          rawValue: text.slice(index + 2, closeIndex),
          start: index,
        });
        index = closeIndex;
        continue;
      }
    }

    const lineEndIndex = getLineEndIndex(text, index + 1);
    const rawValue = text.slice(index + 1, lineEndIndex);
    if (!rawValue.trim()) {
      continue;
    }

    tokens.push({
      end: lineEndIndex,
      explicitBoundary: false,
      kind: "file",
      marker,
      rawValue,
      start: index,
    });
  }

  return tokens;
}

function parseActiveInlineMentionToken(text: string, caretOffset: number): ParsedInlineMentionToken | null {
  if (caretOffset < 0 || caretOffset > text.length) {
    return null;
  }

  const lineStart = Math.max(text.lastIndexOf("\n", caretOffset - 1), text.lastIndexOf("\r", caretOffset - 1)) + 1;
  const prefix = text.slice(lineStart, caretOffset);
  const skillMatch = prefix.match(/(^|\s)\/(\S*)$/);
  if (skillMatch) {
    const leadingText = skillMatch[1] ?? "";
    const rawValue = skillMatch[2] ?? "";
    const start = caretOffset - 1 - rawValue.length;
    if (start === 0 || leadingText.length > 0) {
      return {
        end: caretOffset,
        explicitBoundary: false,
        kind: "skill",
        marker: "/",
        rawValue,
        start,
      };
    }
  }

  for (let index = caretOffset - 1; index >= lineStart; index -= 1) {
    if (text[index] !== "#") {
      continue;
    }

    if (!isInlineMentionBoundary(text[index - 1])) {
      continue;
    }

    const explicitBoundary = text[index + 1] === "[";
    if (explicitBoundary) {
      const closeIndex = text.indexOf("]", index + 2);
      if (closeIndex !== -1 && closeIndex < caretOffset) {
        return null;
      }
    }

    const rawValueStart = explicitBoundary ? index + 2 : index + 1;
    if (rawValueStart > caretOffset) {
      continue;
    }

    return {
      end: caretOffset,
      explicitBoundary,
      kind: "file",
      marker: "#",
      rawValue: text.slice(rawValueStart, caretOffset),
      start: index,
    };
  }

  return null;
}

function getFileMentionValues(rawValue: string, explicitBoundary: boolean) {
  if (explicitBoundary) {
    const value = rawValue.trim();
    return value ? [{ consumedLength: rawValue.length, value }] : [];
  }

  const values: Array<{ consumedLength: number; value: string }> = [];
  const seenValues = new Set<string>();

  const addValue = (end: number) => {
    const candidate = stripTrailingPunctuation(rawValue.slice(0, end).trimEnd());
    if (!candidate || seenValues.has(candidate)) {
      return;
    }

    seenValues.add(candidate);
    values.push({
      consumedLength: rawValue.indexOf(candidate) + candidate.length,
      value: candidate,
    });
  };

  const firstWhitespaceIndex = rawValue.search(/\s/);
  if (firstWhitespaceIndex > 0) {
    addValue(firstWhitespaceIndex);
  } else {
    addValue(rawValue.length);
  }

  const fileEndpointPattern = /\.[A-Za-z0-9][A-Za-z0-9_.-]*(?::\d+(?::\d+)?)?/g;
  let match: RegExpExecArray | null;
  while ((match = fileEndpointPattern.exec(rawValue)) !== null) {
    addValue(match.index + match[0].length);
  }

  return values.sort((left, right) => right.consumedLength - left.consumedLength);
}

function getTokenResolutionEnd(token: ParsedInlineMentionToken, consumedLength: number) {
  return token.explicitBoundary
    ? token.end
    : token.start + token.marker.length + consumedLength;
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

function resolveFileMention(value: string, sources: InlineMentionHighlightSources, {
  allowThreadCwdPathWithoutCandidate,
}: {
  allowThreadCwdPathWithoutCandidate: boolean;
}) {
  const fileCandidates = sources.candidates.filter((candidate) => candidate.kind === "file");
  const resolvedTarget = resolveProjectFileLinkTarget(value, {
    allowThreadCwdPathWithoutCandidate,
    candidatePaths: sources.fileCandidatePaths,
    threadCwdPath: sources.threadCwdPath,
    projectRootPath: sources.projectRootPath,
    workspaceRoots: sources.workspaceRoots,
  });
  if (!resolvedTarget) {
    return null;
  }

  const normalizedTargetPath = normalizeWorkbenchPath(resolvedTarget.relativePath).toLocaleLowerCase();
  const candidate = fileCandidates.find((entry) => (
    normalizeWorkbenchPath(entry.path).toLocaleLowerCase() === normalizedTargetPath
  ));
  if (!candidate && !allowThreadCwdPathWithoutCandidate) {
    return null;
  }

  const resolvedPath = normalizeWorkbenchPath(resolvedTarget.relativePath);
  return {
    candidate: candidate ?? {
      aliases: [resolvedPath],
      description: "",
      isExcluded: false,
      kind: "file",
      label: resolvedPath,
      path: resolvedPath,
    },
    columnNumber: resolvedTarget.columnNumber,
    lineNumber: resolvedTarget.lineNumber,
  };
}

function resolveToken(token: ParsedInlineMentionToken, sources: InlineMentionHighlightSources) {
  const rawCandidate = token.rawValue;
  const strippedCandidate = stripTrailingPunctuation(rawCandidate);
  const values = token.kind === "file"
    ? getFileMentionValues(rawCandidate, token.explicitBoundary)
    : Array.from(new Set([rawCandidate, strippedCandidate].filter(Boolean)))
      .map((value) => ({ consumedLength: value.length, value }));

  for (const { consumedLength, value } of values) {
    if (token.kind === "skill") {
      const match = resolveSkillMention(value, sources.candidates);
      if (!match) {
        continue;
      }

      return {
        candidate: match,
        columnNumber: null,
        end: getTokenResolutionEnd(token, consumedLength),
        lineNumber: null,
        value,
      };
    }

    const match = resolveFileMention(value, sources, {
      allowThreadCwdPathWithoutCandidate: token.explicitBoundary,
    });
    if (match) {
      return {
        candidate: match.candidate,
        columnNumber: match.columnNumber,
        end: getTokenResolutionEnd(token, consumedLength),
        lineNumber: match.lineNumber,
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
  if (candidate.kind === "skill") {
    return `${marker}${candidate.label}`;
  }

  const normalizedPath = normalizeMentionPath(candidate.path);
  return /\s/.test(normalizedPath) ? `#[${normalizedPath}]` : `${marker}${normalizedPath}`;
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

    highlights.push({
      columnNumber: resolution.columnNumber,
      end: resolution.end,
      kind: resolution.candidate.kind,
      label: resolution.candidate.label,
      lineNumber: resolution.lineNumber,
      path: resolution.candidate.path,
      start: token.start,
      text: text.slice(token.start, resolution.end),
      title: resolution.candidate.kind === "skill"
        ? `Known skill: ${resolution.candidate.label}`
        : `Project file: ${resolution.candidate.path}`,
    });
  }

  return highlights;
}
