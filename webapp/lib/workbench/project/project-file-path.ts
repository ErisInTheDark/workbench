/*
 * Exports:
 * - ProjectFilePathLocation: optional line and column metadata for displayed project paths. Keywords: project path, line, column.
 * - ProjectFilePathDisplay: derived label, basename, title, and location suffix for a project path pill. Keywords: project path, display, basename.
 * - ProjectFilePathDisambiguationIndex: prepared shortest-path lookup index for project file path labels. Keywords: project path, display, index.
 * - ProjectFilePathDisplayOptions: optional label override, disambiguation paths/key, and location metadata for project path pills. Keywords: project path, label, line, column.
 * - projectFilePathPillClassName: shared rounded pill classes for project path rendering. Keywords: project path, pill, classes.
 * - projectFilePathInteractiveClassName: shared interactive hover/focus classes for clickable project path pills. Keywords: project path, interactive, classes.
 * - projectFilePathLabelClassName: shared classes for the visible filename text. Keywords: project path, label, classes.
 * - projectFilePathLocationClassName: shared low-contrast classes for line and column suffixes. Keywords: project path, location, classes.
 * - createProjectFilePathDisambiguationIndexCooperatively: build project path disambiguation in browser-yielding slices. Keywords: project path, scheduler, index.
 * - getProjectFilePathDisplay: derive the visible filename, tooltip path, and location suffix for a project-relative path. Keywords: project path, display, tooltip.
 * - readCachedProjectFilePathDisambiguationIndex: return an already-built path disambiguation index without rebuilding. Keywords: project path, cache, index.
 * - writeProjectFilePathDisambiguationIndexCache: store a prepared path disambiguation index in shared caches. Keywords: project path, cache, index.
 */

import type { CooperativeWorkBudget } from "../state/cooperative-work";
import { normalizeWorkbenchPath } from "../markdown/markdown-links";

export interface ProjectFilePathDisambiguationIndex {
  labelByLookupKey: Map<string, string>;
  partitionsByRootKey: Map<string, ProjectFilePathDisambiguationPartition>;
}

interface ProjectFilePathDisambiguationContentCacheEntry {
  index: ProjectFilePathDisambiguationIndex;
  key: string;
  paths: readonly string[];
}

interface ProjectFilePathDisambiguationKeyCacheEntry {
  disambiguationKey: string;
  index: ProjectFilePathDisambiguationIndex;
}

interface ProjectFilePathDisambiguationPartition {
  root: ProjectFilePathDisambiguationTreeNode;
}

interface ProjectFilePathDisambiguationRecord {
  comparableSegments: readonly string[];
  lookupKey: string;
  relativePath: string;
  rootId: string | null;
  rootKey: string;
  segments: readonly string[];
}

interface ProjectFilePathDisambiguationTreeNode {
  candidateCount: number;
  children: Map<string, ProjectFilePathDisambiguationTreeNode>;
}

interface ProjectFilePathDisambiguationInterner {
  internString(value: string): string;
}

const DISAMBIGUATION_INDEX_CONTENT_CACHE_LIMIT = 4;
const disambiguationIndexCache = new WeakMap<readonly string[], ProjectFilePathDisambiguationIndex>();
const disambiguationIndexKeyCache: ProjectFilePathDisambiguationKeyCacheEntry[] = [];
const disambiguationIndexContentCache: ProjectFilePathDisambiguationContentCacheEntry[] = [];

export interface ProjectFilePathLocation {
  columnNumber?: number | null;
  lineNumber?: number | null;
}

export interface ProjectFilePathDisplay {
  fileName: string;
  label: string;
  locationSuffix: string;
  rootPrefix: string;
  title: string;
}

export interface ProjectFilePathDisplayOptions extends ProjectFilePathLocation {
  disambiguationIndex?: ProjectFilePathDisambiguationIndex | null;
  disambiguationKey?: string;
  disambiguationPaths?: readonly string[];
  label?: string | null;
}

export const projectFilePathPillClassName = [
  "inline-flex min-w-0 max-w-full items-baseline gap-[0.04rem] rounded-[0.55rem]",
  "bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-[0.48rem] py-[0.14rem]",
  "font-mono text-[0.78em] leading-[1.6] text-text transition-colors",
  "hover:bg-[color-mix(in_srgb,var(--text)_10%,transparent)]",
].join(" ");

export const projectFilePathInteractiveClassName = [
  "cursor-pointer no-underline",
  "focus-visible:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] focus-visible:outline-none",
].join(" ");

export const projectFilePathLabelClassName = "min-w-0 truncate";

export const projectFilePathLocationClassName = "text-[color:color-mix(in_srgb,var(--text)_54%,transparent)]";

function normalizeComparableProjectFilePath(value: string) {
  return normalizeWorkbenchPath(value).toLocaleLowerCase();
}

function normalizeComparableProjectFilePathSegment(value: string) {
  return value.toLocaleLowerCase();
}

function createProjectFilePathDisambiguationInterner(): ProjectFilePathDisambiguationInterner {
  const strings = new Map<string, string>();
  return {
    internString(value) {
      const cachedValue = strings.get(value);
      if (cachedValue !== undefined) {
        return cachedValue;
      }

      strings.set(value, value);
      return value;
    },
  };
}

function getProjectFilePathSegments(path: string) {
  return normalizeWorkbenchPath(path).split("/").filter(Boolean);
}

function parseWorkspaceQualifiedDisplayPath(path: string) {
  const normalizedPath = normalizeWorkbenchPath(path);
  const separatorIndex = normalizedPath.indexOf(":");
  if (separatorIndex <= 0 || /^[A-Za-z]:\//.test(normalizedPath)) {
    return null;
  }

  const rootId = normalizedPath.slice(0, separatorIndex);
  const relativePath = normalizedPath.slice(separatorIndex + 1).replace(/^\/+/, "");
  return rootId && relativePath
    ? { relativePath, rootId }
    : null;
}

function getProjectFilePathSuffix(path: string, depth: number) {
  return getProjectFilePathSegments(path).slice(-depth).join("/");
}

function getProjectFilePathSuffixFromSegments(segments: readonly string[], depth: number) {
  return segments.slice(-depth).join("/");
}

function getDisambiguationRootKey(rootId: string | null) {
  return rootId?.toLocaleLowerCase() ?? "";
}

function getDisambiguationLookupKey(rootId: string | null, relativePath: string) {
  return `${getDisambiguationRootKey(rootId)}\0${normalizeComparableProjectFilePath(relativePath)}`;
}

function createDisambiguationTreeNode(): ProjectFilePathDisambiguationTreeNode {
  return {
    candidateCount: 0,
    children: new Map<string, ProjectFilePathDisambiguationTreeNode>(),
  };
}

function createDisambiguationPartition(): ProjectFilePathDisambiguationPartition {
  return {
    root: createDisambiguationTreeNode(),
  };
}

function parseProjectFilePathDisambiguationRecord(
  path: string,
  interner: ProjectFilePathDisambiguationInterner,
): ProjectFilePathDisambiguationRecord | null {
  const normalizedPath = interner.internString(normalizeWorkbenchPath(path));
  const workspacePath = parseWorkspaceQualifiedDisplayPath(normalizedPath);
  const relativePath = interner.internString(workspacePath?.relativePath || normalizedPath);
  const segments = getProjectFilePathSegments(relativePath).map((segment) => interner.internString(segment));
  if (!relativePath || !segments.length) {
    return null;
  }

  const rootId = workspacePath?.rootId ? interner.internString(workspacePath.rootId) : null;
  return {
    comparableSegments: segments.map((segment) => interner.internString(normalizeComparableProjectFilePathSegment(segment))),
    lookupKey: interner.internString(getDisambiguationLookupKey(rootId, relativePath)),
    relativePath,
    rootId,
    rootKey: interner.internString(getDisambiguationRootKey(rootId)),
    segments,
  };
}

function addDisambiguationRecordToPartition(
  partition: ProjectFilePathDisambiguationPartition,
  record: ProjectFilePathDisambiguationRecord,
) {
  let node = partition.root;
  for (let index = record.comparableSegments.length - 1; index >= 0; index -= 1) {
    const segment = record.comparableSegments[index];
    let child = node.children.get(segment);
    if (!child) {
      child = createDisambiguationTreeNode();
      node.children.set(segment, child);
    }

    child.candidateCount += 1;
    node = child;
  }
}

function computeShortestDisambiguatedProjectFilePathWithoutIndex(path: string) {
  const normalizedPath = normalizeWorkbenchPath(path);
  const pathSegments = getProjectFilePathSegments(normalizedPath);
  return pathSegments.length
    ? pathSegments[pathSegments.length - 1]
    : normalizedPath || path;
}

function computeShortestDisambiguatedProjectFilePath(
  path: string,
  index: ProjectFilePathDisambiguationIndex | null,
  rootId: string | null,
) {
  if (!index) {
    return computeShortestDisambiguatedProjectFilePathWithoutIndex(path);
  }

  const normalizedPath = normalizeWorkbenchPath(path);
  const pathSegments = getProjectFilePathSegments(normalizedPath);
  if (!pathSegments.length) {
    return normalizedPath || path;
  }

  const partition = index.partitionsByRootKey.get(getDisambiguationRootKey(rootId));
  if (!partition) {
    return getProjectFilePathSuffix(normalizedPath, pathSegments.length);
  }

  let node = partition.root;
  let suffix = "";
  for (let index = pathSegments.length - 1; index >= 0; index -= 1) {
    const segment = pathSegments[index];
    suffix = suffix ? `${segment}/${suffix}` : segment;
    const child = node.children.get(normalizeComparableProjectFilePathSegment(segment));
    if (!child || child.candidateCount <= 1) {
      return suffix;
    }

    node = child;
  }

  return getProjectFilePathSuffixFromSegments(pathSegments, pathSegments.length);
}

function createDisambiguationIndex(disambiguationPaths: readonly string[]): ProjectFilePathDisambiguationIndex {
  const interner = createProjectFilePathDisambiguationInterner();
  const labelByLookupKey = new Map<string, string>();
  const partitionsByRootKey = new Map<string, ProjectFilePathDisambiguationPartition>();
  const records: ProjectFilePathDisambiguationRecord[] = [];
  const seenLookupKeys = new Set<string>();

  for (const path of disambiguationPaths) {
    const record = parseProjectFilePathDisambiguationRecord(path, interner);
    if (!record || seenLookupKeys.has(record.lookupKey)) {
      continue;
    }

    seenLookupKeys.add(record.lookupKey);
    records.push(record);

    let partition = partitionsByRootKey.get(record.rootKey);
    if (!partition) {
      partition = createDisambiguationPartition();
      partitionsByRootKey.set(record.rootKey, partition);
    }

    addDisambiguationRecordToPartition(partition, record);
  }

  const index = {
    labelByLookupKey,
    partitionsByRootKey,
  };

  for (const record of records) {
    labelByLookupKey.set(
      record.lookupKey,
      computeShortestDisambiguatedProjectFilePath(record.relativePath, index, record.rootId),
    );
  }

  return index;
}

export async function createProjectFilePathDisambiguationIndexCooperatively(
  disambiguationPaths: readonly string[],
  budget: CooperativeWorkBudget,
): Promise<ProjectFilePathDisambiguationIndex> {
  const interner = createProjectFilePathDisambiguationInterner();
  const labelByLookupKey = new Map<string, string>();
  const partitionsByRootKey = new Map<string, ProjectFilePathDisambiguationPartition>();
  const records: ProjectFilePathDisambiguationRecord[] = [];
  const seenLookupKeys = new Set<string>();

  for (const path of disambiguationPaths) {
    const record = parseProjectFilePathDisambiguationRecord(path, interner);
    if (!record || seenLookupKeys.has(record.lookupKey)) {
      await budget.yieldIfNeeded();
      continue;
    }

    seenLookupKeys.add(record.lookupKey);
    records.push(record);

    let partition = partitionsByRootKey.get(record.rootKey);
    if (!partition) {
      partition = createDisambiguationPartition();
      partitionsByRootKey.set(record.rootKey, partition);
    }

    addDisambiguationRecordToPartition(partition, record);
    await budget.yieldIfNeeded();
  }

  const index = {
    labelByLookupKey,
    partitionsByRootKey,
  };

  for (const record of records) {
    labelByLookupKey.set(
      record.lookupKey,
      computeShortestDisambiguatedProjectFilePath(record.relativePath, index, record.rootId),
    );
    await budget.yieldIfNeeded();
  }

  return index;
}

function getDisambiguationPathsContentKey(paths: readonly string[]) {
  let hash = 2_166_136_261;
  let totalLength = 0;
  for (const path of paths) {
    totalLength += path.length;
    for (let index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return `${paths.length}:${totalLength}:${(hash >>> 0).toString(36)}`;
}

function areStringListsEqual(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function readDisambiguationIndexContentCache(key: string, paths: readonly string[]) {
  for (let index = disambiguationIndexContentCache.length - 1; index >= 0; index -= 1) {
    const entry = disambiguationIndexContentCache[index];
    if (entry.key !== key || !areStringListsEqual(entry.paths, paths)) {
      continue;
    }

    disambiguationIndexContentCache.splice(index, 1);
    disambiguationIndexContentCache.push(entry);
    return entry.index;
  }

  return null;
}

function writeDisambiguationIndexContentCache(
  key: string,
  paths: readonly string[],
  index: ProjectFilePathDisambiguationIndex,
) {
  disambiguationIndexContentCache.push({
    index,
    key,
    paths: Array.from(paths),
  });
  while (disambiguationIndexContentCache.length > DISAMBIGUATION_INDEX_CONTENT_CACHE_LIMIT) {
    disambiguationIndexContentCache.shift();
  }
}

function readDisambiguationIndexKeyCache(disambiguationKey: string | undefined) {
  if (!disambiguationKey) {
    return null;
  }

  for (let index = disambiguationIndexKeyCache.length - 1; index >= 0; index -= 1) {
    const entry = disambiguationIndexKeyCache[index];
    if (entry.disambiguationKey !== disambiguationKey) {
      continue;
    }

    disambiguationIndexKeyCache.splice(index, 1);
    disambiguationIndexKeyCache.push(entry);
    return entry.index;
  }

  return null;
}

function writeDisambiguationIndexKeyCache(
  disambiguationKey: string | undefined,
  index: ProjectFilePathDisambiguationIndex,
) {
  if (!disambiguationKey) {
    return;
  }

  for (let index = disambiguationIndexKeyCache.length - 1; index >= 0; index -= 1) {
    if (disambiguationIndexKeyCache[index].disambiguationKey === disambiguationKey) {
      disambiguationIndexKeyCache.splice(index, 1);
    }
  }

  disambiguationIndexKeyCache.push({
    disambiguationKey,
    index,
  });
  while (disambiguationIndexKeyCache.length > DISAMBIGUATION_INDEX_CONTENT_CACHE_LIMIT) {
    disambiguationIndexKeyCache.shift();
  }
}

export function readCachedProjectFilePathDisambiguationIndex(
  disambiguationPaths: readonly string[],
  disambiguationKey: string | undefined,
) {
  const keyCachedIndex = readDisambiguationIndexKeyCache(disambiguationKey);
  if (keyCachedIndex) {
    disambiguationIndexCache.set(disambiguationPaths, keyCachedIndex);
    return keyCachedIndex;
  }

  const cachedIndex = disambiguationIndexCache.get(disambiguationPaths);
  if (cachedIndex) {
    writeDisambiguationIndexKeyCache(disambiguationKey, cachedIndex);
    return cachedIndex;
  }

  return null;
}

export function writeProjectFilePathDisambiguationIndexCache(
  disambiguationPaths: readonly string[],
  disambiguationKey: string | undefined,
  index: ProjectFilePathDisambiguationIndex,
) {
  disambiguationIndexCache.set(disambiguationPaths, index);
  writeDisambiguationIndexKeyCache(disambiguationKey, index);
}

function getDisambiguationIndex(
  disambiguationPaths: readonly string[],
  disambiguationKey: string | undefined,
) {
  const cachedIndex = readCachedProjectFilePathDisambiguationIndex(disambiguationPaths, disambiguationKey);
  if (cachedIndex) {
    return cachedIndex;
  }

  const contentKey = disambiguationKey ? "" : getDisambiguationPathsContentKey(disambiguationPaths);
  if (!disambiguationKey) {
    const contentCachedIndex = readDisambiguationIndexContentCache(contentKey, disambiguationPaths);
    if (contentCachedIndex) {
      disambiguationIndexCache.set(disambiguationPaths, contentCachedIndex);
      return contentCachedIndex;
    }
  }

  const index = createDisambiguationIndex(disambiguationPaths);
  disambiguationIndexCache.set(disambiguationPaths, index);
  writeDisambiguationIndexKeyCache(disambiguationKey, index);
  if (!disambiguationKey) {
    writeDisambiguationIndexContentCache(contentKey, disambiguationPaths, index);
  }
  return index;
}

function getShortestDisambiguatedProjectFilePath(
  path: string,
  disambiguationPaths: readonly string[] = [],
  disambiguationKey: string | undefined = undefined,
  disambiguationIndex: ProjectFilePathDisambiguationIndex | null | undefined = undefined,
  rootId: string | null = null,
) {
  if (disambiguationIndex === null) {
    return computeShortestDisambiguatedProjectFilePathWithoutIndex(path);
  }

  if (disambiguationIndex) {
    const lookupKey = getDisambiguationLookupKey(rootId, path);
    const cachedLabel = disambiguationIndex.labelByLookupKey.get(lookupKey);
    if (cachedLabel) {
      return cachedLabel;
    }

    const label = computeShortestDisambiguatedProjectFilePath(path, disambiguationIndex, rootId);
    disambiguationIndex.labelByLookupKey.set(lookupKey, label);
    return label;
  }

  if (!disambiguationPaths.length) {
    return computeShortestDisambiguatedProjectFilePathWithoutIndex(path);
  }

  const index = getDisambiguationIndex(disambiguationPaths, disambiguationKey);
  const lookupKey = getDisambiguationLookupKey(rootId, path);
  const cachedLabel = index.labelByLookupKey.get(lookupKey);
  if (cachedLabel) {
    return cachedLabel;
  }

  const label = computeShortestDisambiguatedProjectFilePath(path, index, rootId);
  index.labelByLookupKey.set(lookupKey, label);
  return label;
}

export function getProjectFilePathDisplay(
  path: string,
  {
    label = null,
    disambiguationIndex,
    columnNumber = null,
    disambiguationKey,
    disambiguationPaths = [],
    lineNumber = null,
  }: ProjectFilePathDisplayOptions = {},
): ProjectFilePathDisplay {
  const normalizedPath = normalizeWorkbenchPath(path);
  const workspacePath = parseWorkspaceQualifiedDisplayPath(normalizedPath);
  const displayPath = workspacePath?.relativePath || normalizedPath || path;
  const pathSegments = displayPath.split("/").filter(Boolean);
  const fileName = pathSegments[pathSegments.length - 1] || displayPath;
  const displayLabel = getShortestDisambiguatedProjectFilePath(
    displayPath,
    disambiguationPaths,
    disambiguationKey,
    disambiguationIndex,
    workspacePath?.rootId ?? null,
  );
  const rootPrefix = workspacePath && !label?.startsWith(`${workspacePath.rootId}:`)
    ? `${workspacePath.rootId}:`
    : "";
  const locationSuffix = lineNumber === null
    ? ""
    : `:${lineNumber}${columnNumber === null ? "" : `:${columnNumber}`}`;

  return {
    fileName,
    label: label ?? displayLabel,
    locationSuffix,
    rootPrefix,
    title: normalizedPath || path,
  };
}
