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
  fileSearch?: InlineMentionFileSearchMetadata;
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

interface InlineMentionFileSearchMetadata {
  basename: string;
  basenameStem: string;
  comparableBasename: string;
  comparableBasenameStem: string;
  comparablePath: string;
  comparableSegments: readonly string[];
  path: string;
  searchParts: readonly InlineMentionFileSearchPart[];
  segments: readonly string[];
}

interface InlineMentionFileSearchPart {
  comparableText: string;
  isBasename: boolean;
  text: string;
}

interface PreparedInlineMentionFileRecord {
  isExcluded: boolean;
  path: string;
}

interface PreparedInlineMentionFiles {
  candidates: InlineMentionCandidate[];
  fileCandidatePaths: readonly string[];
  key: string;
  records: readonly PreparedInlineMentionFileRecord[];
}

interface PreparedInlineMentionSkillRecord {
  description: string;
  name: string;
  path: string;
  relativePath: string;
}

interface PreparedInlineMentionSkills {
  candidates: InlineMentionCandidate[];
  key: string;
  records: readonly PreparedInlineMentionSkillRecord[];
}

interface InlineMentionSourcesCacheEntry {
  cacheKey: string;
  files: PreparedInlineMentionFiles;
  projectRootPath?: string;
  skills: PreparedInlineMentionSkills;
  sources: InlineMentionHighlightSources;
  threadCwdPath?: string;
  workspaceRootsKey: string;
}

interface InlineMentionRecordKeyBuilder {
  count: number;
  hash: number;
  totalLength: number;
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
const INLINE_MENTION_SOURCE_CACHE_LIMIT = 8;
const preparedFileInputsByIdentity = new WeakMap<readonly (string | InlineMentionFileCandidateInput)[], PreparedInlineMentionFiles>();
const preparedFileInputsByContent: PreparedInlineMentionFiles[] = [];
const preparedSkillInputsByIdentity = new WeakMap<readonly WorkbenchSkillSummary[], PreparedInlineMentionSkills>();
const preparedSkillInputsByContent: PreparedInlineMentionSkills[] = [];
const inlineMentionSourcesCache: InlineMentionSourcesCacheEntry[] = [];

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

function createInlineMentionRecordKeyBuilder(): InlineMentionRecordKeyBuilder {
  return {
    count: 0,
    hash: 2_166_136_261,
    totalLength: 0,
  };
}

function addInlineMentionRecordKeyValue(builder: InlineMentionRecordKeyBuilder, value: string) {
  builder.count += 1;
  builder.totalLength += value.length;
  for (let index = 0; index < value.length; index += 1) {
    builder.hash ^= value.charCodeAt(index);
    builder.hash = Math.imul(builder.hash, 16_777_619);
  }

  builder.hash ^= 0;
  builder.hash = Math.imul(builder.hash, 16_777_619);
}

function finishInlineMentionRecordKey(builder: InlineMentionRecordKeyBuilder) {
  return `${builder.count}:${builder.totalLength}:${(builder.hash >>> 0).toString(36)}`;
}

function getFilePathStem(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function splitMentionSearchWords(value: string) {
  return normalizeMentionPath(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function createInlineMentionFileSearchMetadata(path: string): InlineMentionFileSearchMetadata {
  const normalizedPath = normalizeMentionPath(path);
  const segments = getPathSegments(normalizedPath);
  const basename = segments[segments.length - 1] ?? normalizedPath;
  const basenameStem = getFilePathStem(basename);
  const searchParts: InlineMentionFileSearchPart[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isBasename = index === segments.length - 1;
    const values = isBasename
      ? [segment, basenameStem, ...splitMentionSearchWords(basenameStem)]
      : [segment, ...splitMentionSearchWords(segment)];

    for (const value of values) {
      const comparableText = normalizeComparableValue(value);
      if (!comparableText || searchParts.some((part) => part.comparableText === comparableText && part.isBasename === isBasename)) {
        continue;
      }

      searchParts.push({
        comparableText,
        isBasename,
        text: value,
      });
    }
  }

  return {
    basename,
    basenameStem,
    comparableBasename: normalizeComparableValue(basename),
    comparableBasenameStem: normalizeComparableValue(basenameStem),
    comparablePath: normalizeComparableValue(normalizedPath),
    comparableSegments: segments.map(normalizeComparableValue),
    path: normalizedPath,
    searchParts,
    segments,
  };
}

function createInlineMentionFileCandidate(record: PreparedInlineMentionFileRecord): InlineMentionCandidate {
  const fileSearch = createInlineMentionFileSearchMetadata(record.path);
  return {
    aliases: [record.path],
    description: "",
    fileSearch,
    isExcluded: record.isExcluded,
    kind: "file",
    label: record.path,
    path: record.path,
  };
}

function arePreparedFileRecordsEqual(
  left: readonly PreparedInlineMentionFileRecord[],
  right: readonly PreparedInlineMentionFileRecord[],
) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index].path !== right[index].path || left[index].isExcluded !== right[index].isExcluded) {
      return false;
    }
  }

  return true;
}

function prepareInlineMentionFiles(files: readonly (string | InlineMentionFileCandidateInput)[]): PreparedInlineMentionFiles {
  const cachedFiles = preparedFileInputsByIdentity.get(files);
  if (cachedFiles) {
    return cachedFiles;
  }

  const keyBuilder = createInlineMentionRecordKeyBuilder();
  const records: PreparedInlineMentionFileRecord[] = [];
  for (const file of files) {
    const record = {
      isExcluded: typeof file === "string" ? false : Boolean(file.isIgnored),
      path: normalizeMentionPath(typeof file === "string" ? file : file.path),
    };
    records.push(record);
    addInlineMentionRecordKeyValue(keyBuilder, record.isExcluded ? "1" : "0");
    addInlineMentionRecordKeyValue(keyBuilder, record.path);
  }
  const key = finishInlineMentionRecordKey(keyBuilder);
  const contentCachedFiles = preparedFileInputsByContent.find((entry) => (
    entry.key === key && arePreparedFileRecordsEqual(entry.records, records)
  ));
  if (contentCachedFiles) {
    preparedFileInputsByIdentity.set(files, contentCachedFiles);
    return contentCachedFiles;
  }

  const preparedFiles: PreparedInlineMentionFiles = {
    candidates: records.map(createInlineMentionFileCandidate),
    fileCandidatePaths: records.map((record) => record.path),
    key,
    records,
  };
  preparedFileInputsByIdentity.set(files, preparedFiles);
  preparedFileInputsByContent.push(preparedFiles);
  while (preparedFileInputsByContent.length > INLINE_MENTION_SOURCE_CACHE_LIMIT) {
    preparedFileInputsByContent.shift();
  }
  return preparedFiles;
}

function arePreparedSkillRecordsEqual(
  left: readonly PreparedInlineMentionSkillRecord[],
  right: readonly PreparedInlineMentionSkillRecord[],
) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].description !== right[index].description
      || left[index].name !== right[index].name
      || left[index].path !== right[index].path
      || left[index].relativePath !== right[index].relativePath
    ) {
      return false;
    }
  }

  return true;
}

function prepareInlineMentionSkills(skills: readonly WorkbenchSkillSummary[]): PreparedInlineMentionSkills {
  const cachedSkills = preparedSkillInputsByIdentity.get(skills);
  if (cachedSkills) {
    return cachedSkills;
  }

  const keyBuilder = createInlineMentionRecordKeyBuilder();
  const records: PreparedInlineMentionSkillRecord[] = [];
  for (const skill of skills) {
    const record = {
      description: skill.description,
      name: skill.name,
      path: skill.path,
      relativePath: skill.relativePath,
    };
    records.push(record);
    addInlineMentionRecordKeyValue(keyBuilder, record.name);
    addInlineMentionRecordKeyValue(keyBuilder, record.path);
    addInlineMentionRecordKeyValue(keyBuilder, record.relativePath);
    addInlineMentionRecordKeyValue(keyBuilder, record.description);
  }
  const key = finishInlineMentionRecordKey(keyBuilder);
  const contentCachedSkills = preparedSkillInputsByContent.find((entry) => (
    entry.key === key && arePreparedSkillRecordsEqual(entry.records, records)
  ));
  if (contentCachedSkills) {
    preparedSkillInputsByIdentity.set(skills, contentCachedSkills);
    return contentCachedSkills;
  }

  const preparedSkills: PreparedInlineMentionSkills = {
    candidates: records.map((skill): InlineMentionCandidate => {
      const directoryAlias = getSkillDirectoryAlias(skill);
      return {
        aliases: Array.from(new Set([skill.name, directoryAlias].filter(Boolean))),
        description: skill.description,
        kind: "skill",
        label: skill.name,
        path: skill.path,
      };
    }),
    key,
    records,
  };
  preparedSkillInputsByIdentity.set(skills, preparedSkills);
  preparedSkillInputsByContent.push(preparedSkills);
  while (preparedSkillInputsByContent.length > INLINE_MENTION_SOURCE_CACHE_LIMIT) {
    preparedSkillInputsByContent.shift();
  }
  return preparedSkills;
}

function getWorkspaceRootsCacheKey(workspaceRoots: readonly WorkspaceFileLinkRoot[]) {
  const keyBuilder = createInlineMentionRecordKeyBuilder();
  for (const root of workspaceRoots) {
    addInlineMentionRecordKeyValue(keyBuilder, root.id);
    addInlineMentionRecordKeyValue(keyBuilder, root.rootPath);
  }
  return finishInlineMentionRecordKey(keyBuilder);
}

function readInlineMentionSourcesCache({
  cacheKey,
  files,
  projectRootPath,
  skills,
  threadCwdPath,
  workspaceRootsKey,
}: Omit<InlineMentionSourcesCacheEntry, "sources">) {
  for (let index = inlineMentionSourcesCache.length - 1; index >= 0; index -= 1) {
    const entry = inlineMentionSourcesCache[index];
    if (
      entry.cacheKey !== cacheKey
      || entry.files !== files
      || entry.projectRootPath !== projectRootPath
      || entry.skills !== skills
      || entry.threadCwdPath !== threadCwdPath
      || entry.workspaceRootsKey !== workspaceRootsKey
    ) {
      continue;
    }

    inlineMentionSourcesCache.splice(index, 1);
    inlineMentionSourcesCache.push(entry);
    return entry.sources;
  }

  return null;
}

function writeInlineMentionSourcesCache(entry: InlineMentionSourcesCacheEntry) {
  inlineMentionSourcesCache.push(entry);
  while (inlineMentionSourcesCache.length > INLINE_MENTION_SOURCE_CACHE_LIMIT) {
    inlineMentionSourcesCache.shift();
  }
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
  const preparedFiles = prepareInlineMentionFiles(files);
  const preparedSkills = prepareInlineMentionSkills(skills);
  const workspaceRootsKey = getWorkspaceRootsCacheKey(workspaceRoots);
  const cacheKey = [
    projectRootPath ?? "",
    threadCwdPath ?? "",
    workspaceRootsKey,
    preparedFiles.key,
    preparedSkills.key,
  ].join("|");
  const cachedSources = readInlineMentionSourcesCache({
    cacheKey,
    files: preparedFiles,
    projectRootPath,
    skills: preparedSkills,
    threadCwdPath,
    workspaceRootsKey,
  });
  if (cachedSources) {
    return cachedSources;
  }

  const sources: InlineMentionHighlightSources = {
    candidates: [
      ...preparedSkills.candidates,
      ...preparedFiles.candidates,
    ],
    cacheKey,
    fileCandidatePaths: preparedFiles.fileCandidatePaths,
    threadCwdPath,
    projectRootPath,
    workspaceRoots,
  };
  writeInlineMentionSourcesCache({
    cacheKey,
    files: preparedFiles,
    projectRootPath,
    skills: preparedSkills,
    sources,
    threadCwdPath,
    workspaceRootsKey,
  });
  return sources;
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

function getSubsequencePrefixMatch(query: string, value: string) {
  let queryIndex = 0;
  let firstMatchIndex = -1;
  let lastMatchIndex = -1;
  let gapScore = 0;
  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
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

  return queryIndex
    ? {
      firstMatchIndex,
      gapScore,
      length: queryIndex,
    }
    : null;
}

function getLongestContainedQueryPrefix(query: string, value: string) {
  for (let length = query.length; length > 0; length -= 1) {
    const prefix = query.slice(0, length);
    const index = value.indexOf(prefix);
    if (index !== -1) {
      return {
        index,
        length,
      };
    }
  }

  return null;
}

function scoreInlineMentionPartChunk(query: string, part: InlineMentionFileSearchPart) {
  if (!query) {
    return null;
  }

  if (part.comparableText.startsWith(query)) {
    return {
      length: query.length,
      score: part.isBasename ? 0 : 6,
    };
  }

  const containedPrefix = getLongestContainedQueryPrefix(query, part.comparableText);
  const subsequencePrefix = getSubsequencePrefixMatch(query, part.comparableText);
  const containedScore = containedPrefix
    ? {
      length: containedPrefix.length,
      score: (part.isBasename ? 8 : 16) + containedPrefix.index + Math.max(0, query.length - containedPrefix.length) * 3,
    }
    : null;
  const subsequenceScore = subsequencePrefix
    ? {
      length: subsequencePrefix.length,
      score: (part.isBasename ? 18 : 28) + subsequencePrefix.firstMatchIndex + subsequencePrefix.gapScore + Math.max(0, query.length - subsequencePrefix.length) * 5,
    }
    : null;

  if (!containedScore) {
    return subsequenceScore;
  }
  if (!subsequenceScore) {
    return containedScore;
  }

  if (containedScore.length !== subsequenceScore.length) {
    return containedScore.length > subsequenceScore.length ? containedScore : subsequenceScore;
  }

  return containedScore.score <= subsequenceScore.score ? containedScore : subsequenceScore;
}

function getOrderedPathPartMatchScore(query: string, metadata: InlineMentionFileSearchMetadata) {
  let queryIndex = 0;
  let matchedBasename = false;
  let skippedParts = 0;
  let score = 34;

  for (const part of metadata.searchParts) {
    if (queryIndex >= query.length) {
      break;
    }

    const chunk = scoreInlineMentionPartChunk(query.slice(queryIndex), part);
    if (!chunk) {
      skippedParts += 1;
      continue;
    }

    matchedBasename = matchedBasename || part.isBasename;
    score += chunk.score + Math.min(skippedParts, 6) * 2;
    queryIndex += chunk.length;
    skippedParts = 0;
  }

  if (queryIndex < query.length) {
    return null;
  }

  return score
    - Math.min(query.length, 12)
    - (matchedBasename ? 8 : 0);
}

function getFileSuggestionScore(query: string, candidate: InlineMentionCandidate) {
  const normalizedQuery = normalizeComparableValue(query);
  if (!normalizedQuery) {
    return null;
  }

  const metadata = candidate.fileSearch ?? createInlineMentionFileSearchMetadata(candidate.path);
  if (
    metadata.comparablePath === normalizedQuery
    || metadata.comparableBasename === normalizedQuery
    || metadata.comparableBasenameStem === normalizedQuery
  ) {
    return 0;
  }

  if (metadata.comparableBasenameStem.startsWith(normalizedQuery) || metadata.comparableBasename.startsWith(normalizedQuery)) {
    return 5;
  }

  const basenameRunIndex = metadata.comparableBasenameStem.indexOf(normalizedQuery);
  if (basenameRunIndex !== -1) {
    return 9 + basenameRunIndex;
  }

  if (metadata.comparablePath.startsWith(normalizedQuery)) {
    return 14;
  }

  if (metadata.comparableSegments.some((segment) => segment.startsWith(normalizedQuery))) {
    return 18;
  }

  const segmentRunIndexes = metadata.comparableSegments
    .map((segment) => segment.indexOf(normalizedQuery))
    .filter((index) => index !== -1);
  if (segmentRunIndexes.length) {
    return 25 + Math.min(...segmentRunIndexes);
  }

  const orderedPathPartScore = getOrderedPathPartMatchScore(normalizedQuery, metadata);
  if (orderedPathPartScore !== null) {
    return orderedPathPartScore;
  }

  if (metadata.comparablePath.includes(normalizedQuery)) {
    return 50 + metadata.comparablePath.indexOf(normalizedQuery);
  }

  return getFuzzyMatchScore(query, metadata.path);
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

  const metadata = candidate.fileSearch ?? createInlineMentionFileSearchMetadata(candidate.path);
  const normalizedPath = metadata.comparablePath;
  const firstSegment = metadata.segments[0] ?? "";
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
