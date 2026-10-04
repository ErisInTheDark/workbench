/*
 * Exports:
 * - projectFilePathBackgroundClassName: shared file-link background tone.
 * - ProjectFilePathLocation: optional line and column metadata.
 * - ProjectFilePathDisplay: derived label, basename, title, and location suffix.
 * - ProjectFilePathDisambiguationIndex: shortest-path lookup index for file labels.
 * - ProjectFilePathDisplayOptions: label, absolute target, disambiguation, and location inputs.
 * - projectFilePathPillClassName: shared rounded path pill classes.
 * - projectFilePathInteractiveClassName: clickable pill hover and focus classes.
 * - projectFilePathStaticClassName: border-only non-clickable pill classes.
 * - projectFilePathMissingClassName: non-clickable missing path classes.
 * - projectFilePathLabelClassName: visible filename text classes.
 * - projectFilePathLocationClassName: low-contrast line and column classes.
 * - createProjectFilePathDisambiguationIndexCooperatively: build disambiguation in browser-yielding slices.
 * - getProjectFilePathDisplay: derive filename, tooltip, and location display.
 * - isProjectDirectoryPath: identify tracked directory prefixes.
 * - readCachedProjectFilePathDisambiguationIndex: read a prepared disambiguation index.
 * - writeProjectFilePathDisambiguationIndexCache: cache a prepared disambiguation index.
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
const directoryDisambiguationPathsCache = new WeakMap<readonly string[], string[]>();
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
  absolutePath?: string | null;
  disambiguationIndex?: ProjectFilePathDisambiguationIndex | null;
  disambiguationKey?: string;
  disambiguationPaths?: readonly string[];
  label?: string | null;
  targetType?: "directory" | "file";
}

export const projectFilePathBackgroundClassName = "bg-[color-mix(in_srgb,var(--text)_6%,transparent)]";

export const projectFilePathPillClassName = [
  "inline-flex min-w-0 max-w-full items-baseline gap-[0.04rem] rounded-[0.55rem]",
  projectFilePathBackgroundClassName,
  "[--file-path-fg-bg:color-mix(in_srgb,var(--text)_6%,var(--fg-bg,var(--bg)))] px-[0.48rem] py-[0.14rem]",
  "font-mono text-[0.78em] leading-[1.6] text-text transition-colors",
  "hover:bg-[color-mix(in_srgb,var(--text)_10%,transparent)]",
].join(" ");

export const projectFilePathInteractiveClassName = [
  "cursor-pointer no-underline",
  "focus-visible:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] focus-visible:outline-none",
].join(" ");

export const projectFilePathStaticClassName = [
  "border border-[color-mix(in_srgb,var(--text)_24%,transparent)]",
  "!bg-transparent [--file-path-fg-bg:var(--fg-bg,var(--bg))] hover:!bg-transparent",
].join(" ");

export const projectFilePathMissingClassName = [
  projectFilePathStaticClassName,
  "text-[color:color-mix(in_srgb,var(--text)_82%,var(--file-path-fg-bg))]",
].join(" ");

export const projectFilePathLabelClassName = "min-w-0 truncate";

export const projectFilePathLocationClassName = "text-[color:color-mix(in_srgb,var(--text)_54%,var(--file-path-fg-bg))]";

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

function formatWorkspaceQualifiedDisplayPath(rootId: string, relativePath: string) {
  return `${rootId}:${relativePath.replace(/^\/+/, "")}`;
}

function getProjectFileDirectoryPrefixes(path: string) {
  const normalizedPath = normalizeWorkbenchPath(path);
  const workspacePath = parseWorkspaceQualifiedDisplayPath(normalizedPath);
  const rootId = workspacePath?.rootId ?? null;
  const relativePath = workspacePath?.relativePath || normalizedPath;
  const segments = getProjectFilePathSegments(relativePath);
  const prefixes: string[] = [];
  for (let depth = 1; depth < segments.length; depth += 1) {
    const prefix = getProjectFilePathSuffixFromSegments(segments.slice(0, depth), depth);
    prefixes.push(rootId ? formatWorkspaceQualifiedDisplayPath(rootId, prefix) : prefix);
  }

  return prefixes;
}

function getDirectoryDisambiguationPaths(disambiguationPaths: readonly string[]) {
  const cachedPaths = directoryDisambiguationPathsCache.get(disambiguationPaths);
  if (cachedPaths) {
    return cachedPaths;
  }

  const pathsByLookupKey = new Map<string, string>();
  for (const path of disambiguationPaths) {
    for (const directoryPath of getProjectFileDirectoryPrefixes(path)) {
      const workspacePath = parseWorkspaceQualifiedDisplayPath(directoryPath);
      const relativePath = workspacePath?.relativePath || directoryPath;
      pathsByLookupKey.set(
        getDisambiguationLookupKey(workspacePath?.rootId ?? null, relativePath),
        directoryPath,
      );
    }
  }

  const directoryPaths = Array.from(pathsByLookupKey.values());
  directoryDisambiguationPathsCache.set(disambiguationPaths, directoryPaths);
  return directoryPaths;
}

export function isProjectDirectoryPath(path: string, projectFilePaths: readonly string[]) {
  const comparablePath = normalizeComparableProjectFilePath(path);
  return getDirectoryDisambiguationPaths(projectFilePaths).some((directoryPath) => (
    normalizeComparableProjectFilePath(directoryPath) === comparablePath
  ));
}

function formatDirectoryDisplayLabel(label: string) {
  const withoutTrailingSlash = label.replace(/\/+$/, "");
  return withoutTrailingSlash ? `${withoutTrailingSlash}/` : "/";
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

function parseRepoMountPath(path: string) {
  if (!/^(?:[a-z]:\/|\/)/iu.test(path)) return null;
  // Repo mounts pin commits, unlike ordinary folders merely named repos or mounts.
  const match = /^(.*(?:^|\/)\.cache\/repos\/mounts\/([^/]+(?:\/[^/]+)+?)\/[0-9a-f]{40}(?:[0-9a-f]{24})?)(?:\/(.*))?$/iu.exec(path);
  if (!match) return null;
  const name = match[2].split("/").at(-1)!;
  return {
    mountPath: match[1],
    name: name.replace(/~([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    relativePath: match[3] ?? "",
  };
}

export function getProjectFilePathDisplay(
  path: string,
  {
    absolutePath = null,
    label = null,
    disambiguationIndex,
    columnNumber = null,
    disambiguationKey,
    disambiguationPaths = [],
    lineNumber = null,
    targetType = "file",
  }: ProjectFilePathDisplayOptions = {},
): ProjectFilePathDisplay {
  const normalizedPath = normalizeWorkbenchPath(path);
  const repoPath = parseRepoMountPath(normalizeWorkbenchPath(absolutePath ?? path));
  const workspacePath = parseWorkspaceQualifiedDisplayPath(normalizedPath);
  const displayPath = repoPath?.relativePath || workspacePath?.relativePath || normalizedPath || path;
  const pathSegments = displayPath.split("/").filter(Boolean);
  const fileName = pathSegments[pathSegments.length - 1] || displayPath;
  const repoDisambiguationPaths = repoPath
    ? disambiguationPaths.flatMap(candidate => {
      const repoCandidate = parseRepoMountPath(normalizeWorkbenchPath(candidate));
      return repoCandidate?.mountPath === repoPath.mountPath ? [repoCandidate.relativePath] : [];
    })
    : disambiguationPaths;
  const displayDisambiguationPaths = targetType === "directory"
    ? getDirectoryDisambiguationPaths(repoDisambiguationPaths)
    : repoDisambiguationPaths;
  const displayLabel = getShortestDisambiguatedProjectFilePath(
    displayPath,
    displayDisambiguationPaths,
    repoPath ? undefined : targetType === "directory" && disambiguationKey ? `directories:${disambiguationKey}` : disambiguationKey,
    repoPath || targetType === "directory" ? undefined : disambiguationIndex,
    repoPath ? null : workspacePath?.rootId ?? null,
  );
  const rootPrefix = repoPath ? `repo:${repoPath.name}:` : workspacePath && !label?.startsWith(`${workspacePath.rootId}:`)
    ? `${workspacePath.rootId}:`
    : "";
  const locationSuffix = lineNumber === null
    ? ""
    : `:${lineNumber}${columnNumber === null ? "" : `:${columnNumber}`}`;

  return {
    fileName,
    label: targetType === "directory"
      ? formatDirectoryDisplayLabel(label ?? displayLabel)
      : label ?? displayLabel,
    locationSuffix,
    rootPrefix,
    title: repoPath ? normalizeWorkbenchPath(absolutePath ?? path) : normalizedPath || path,
  };
}
