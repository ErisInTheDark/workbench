/*
 * Exports:
 * - ProjectFilePathLocation: optional line and column metadata for displayed project paths. Keywords: project path, line, column.
 * - ProjectFilePathDisplay: derived label, basename, title, and location suffix for a project path pill. Keywords: project path, display, basename.
 * - ProjectFilePathDisplayOptions: optional label override, disambiguation paths, and location metadata for project path pills. Keywords: project path, label, line, column.
 * - projectFilePathPillClassName: shared rounded pill classes for project path rendering. Keywords: project path, pill, classes.
 * - projectFilePathInteractiveClassName: shared interactive hover/focus classes for clickable project path pills. Keywords: project path, interactive, classes.
 * - projectFilePathLabelClassName: shared classes for the visible filename text. Keywords: project path, label, classes.
 * - projectFilePathLocationClassName: shared low-contrast classes for line and column suffixes. Keywords: project path, location, classes.
 * - getProjectFilePathDisplay: derive the visible filename, tooltip path, and location suffix for a project-relative path. Keywords: project path, display, tooltip.
 */

import { normalizeWorkbenchPath } from "../markdown/markdown-links";

interface ProjectFilePathDisambiguationIndex {
  labelByComparablePath: Map<string, string>;
  suffixCounts: Map<string, number>;
}

const disambiguationIndexCache = new WeakMap<readonly string[], ProjectFilePathDisambiguationIndex>();

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

function computeShortestDisambiguatedProjectFilePath(
  path: string,
  suffixCounts: ReadonlyMap<string, number>,
) {
  const normalizedPath = normalizeWorkbenchPath(path);
  const pathSegments = getProjectFilePathSegments(normalizedPath);
  if (!pathSegments.length) {
    return normalizedPath || path;
  }

  if (!suffixCounts.size) {
    return pathSegments[pathSegments.length - 1];
  }

  for (let depth = 1; depth <= pathSegments.length; depth += 1) {
    const suffix = pathSegments.slice(-depth).join("/");
    const comparableSuffix = suffix.toLocaleLowerCase();
    const matchingCandidateCount = suffixCounts.get(comparableSuffix) ?? 0;
    if (matchingCandidateCount <= 1) {
      return suffix;
    }
  }

  return getProjectFilePathSuffix(normalizedPath, pathSegments.length);
}

function createDisambiguationIndex(disambiguationPaths: readonly string[]): ProjectFilePathDisambiguationIndex {
  const suffixCounts = new Map<string, number>();
  const seenComparablePaths = new Set<string>();
  for (const path of disambiguationPaths) {
    const normalizedPath = normalizeWorkbenchPath(path);
    const comparablePath = normalizeComparableProjectFilePath(normalizedPath);
    if (!normalizedPath || seenComparablePaths.has(comparablePath)) {
      continue;
    }

    seenComparablePaths.add(comparablePath);
    const pathSegments = getProjectFilePathSegments(normalizedPath);
    for (let depth = 1; depth <= pathSegments.length; depth += 1) {
      const comparableSuffix = pathSegments.slice(-depth).join("/").toLocaleLowerCase();
      suffixCounts.set(comparableSuffix, (suffixCounts.get(comparableSuffix) ?? 0) + 1);
    }
  }

  return {
    labelByComparablePath: new Map<string, string>(),
    suffixCounts,
  };
}

function getDisambiguationIndex(disambiguationPaths: readonly string[]) {
  const cachedIndex = disambiguationIndexCache.get(disambiguationPaths);
  if (cachedIndex) {
    return cachedIndex;
  }

  const index = createDisambiguationIndex(disambiguationPaths);
  disambiguationIndexCache.set(disambiguationPaths, index);
  return index;
}

function getShortestDisambiguatedProjectFilePath(
  path: string,
  disambiguationPaths: readonly string[] = [],
) {
  if (!disambiguationPaths.length) {
    return computeShortestDisambiguatedProjectFilePath(path, new Map());
  }

  const index = getDisambiguationIndex(disambiguationPaths);
  const comparablePath = normalizeComparableProjectFilePath(path);
  const cachedLabel = index.labelByComparablePath.get(comparablePath);
  if (cachedLabel) {
    return cachedLabel;
  }

  const label = computeShortestDisambiguatedProjectFilePath(path, index.suffixCounts);
  index.labelByComparablePath.set(comparablePath, label);
  return label;
}

export function getProjectFilePathDisplay(
  path: string,
  {
    label = null,
    columnNumber = null,
    disambiguationPaths = [],
    lineNumber = null,
  }: ProjectFilePathDisplayOptions = {},
): ProjectFilePathDisplay {
  const normalizedPath = normalizeWorkbenchPath(path);
  const workspacePath = parseWorkspaceQualifiedDisplayPath(normalizedPath);
  const displayPath = workspacePath?.relativePath || normalizedPath || path;
  const pathSegments = displayPath.split("/").filter(Boolean);
  const fileName = pathSegments[pathSegments.length - 1] || displayPath;
  const displayLabel = getShortestDisambiguatedProjectFilePath(displayPath, disambiguationPaths);
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
