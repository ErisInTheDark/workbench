/*
 * Exports:
 * - normalizeWorkbenchPath: normalize local paths to forward-slash form for display and comparison. Keywords: path, normalize, local.
 * - normalizeMarkdownHref: unwrap markdown link destinations and normalize Windows absolute-path prefixes. Keywords: markdown, href, normalize.
 * - parseCodexFileLinkHref: parse absolute local file links with optional `:line[:column]` suffixes. Keywords: codex, file link, line number, column.
 * - resolveProjectFileLinkTarget: resolve absolute, relative, suffix, or explicit missing project file references. Keywords: project file, absolute link, missing file, resolver.
 * - appendCodexFileLinkLocation: append missing `:line[:column]` suffixes to codex file-link labels. Keywords: codex, file link, label, location.
 * - toProjectRelativeFilePath: convert an absolute local path into a project-relative path when it belongs to the current project root. Keywords: path, project root, relative.
 * - toWorkbenchDisplayPath: normalize a path for UI display and prefer project-relative forward-slash paths when possible. Keywords: path, display, project root.
 */

export interface ProjectFileLinkTarget {
  absolutePath: string | null;
  columnNumber: number | null;
  exists: boolean;
  lineNumber: number | null;
  openPath: string;
  projectId: string | null;
  relativePath: string;
}

export interface WorkspaceFileLinkRoot {
  id: string;
  openPathMode?: "absolute" | "root-relative" | "workspace-qualified";
  projectId?: string | null;
  rootPath: string;
}

const uniqueCandidatePathsCache = new WeakMap<readonly string[], string[]>();

export function normalizeWorkbenchPath(value: string) {
  let normalizedValue = String(value ?? "").trim();
  if (
    (normalizedValue.startsWith("\"") && normalizedValue.endsWith("\""))
    || (normalizedValue.startsWith("'") && normalizedValue.endsWith("'"))
  ) {
    normalizedValue = normalizedValue.slice(1, -1).trim();
  }

  return normalizedValue
    .replace(/^\/([A-Za-z]:[\\/])/, "$1")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function isWindowsAbsolutePath(value: string) {
  return /^[A-Za-z]:\//.test(value);
}

export function normalizeMarkdownHref(value: string) {
  let normalized = String(value ?? "").trim();
  if (normalized.startsWith("<") && normalized.endsWith(">")) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (/^\/[A-Za-z]:[\\/]/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

export function parseCodexFileLinkHref(value: string) {
  const normalizedHref = normalizeMarkdownHref(value);
  if (!normalizedHref) {
    return null;
  }

  let absolutePath = normalizedHref;
  let lineNumber: number | null = null;
  let columnNumber: number | null = null;
  const locationMatch = normalizedHref.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (locationMatch) {
    const candidatePath = normalizeWorkbenchPath(locationMatch[1]);
    if (/^(?:[A-Za-z]:\/|\/)/.test(candidatePath)) {
      absolutePath = locationMatch[1];
      lineNumber = Number(locationMatch[2]);
      columnNumber = locationMatch[3] ? Number(locationMatch[3]) : null;
    }
  }

  const normalizedAbsolutePath = normalizeWorkbenchPath(absolutePath);
  if (!/^(?:[A-Za-z]:\/|\/)/.test(normalizedAbsolutePath)) {
    return null;
  }

  return {
    absolutePath: normalizedAbsolutePath,
    columnNumber,
    lineNumber,
  };
}

function parseProjectFileLinkLocation(value: string) {
  const match = value.match(/^(.*):(\d+)(?::(\d+))?$/);
  return match
    ? {
      columnNumber: match[3] ? Number(match[3]) : null,
      lineNumber: Number(match[2]),
      path: match[1],
    }
    : {
      columnNumber: null,
      lineNumber: null,
      path: value,
    };
}

function normalizeComparableProjectPath(value: string) {
  return normalizeWorkbenchPath(value).toLowerCase();
}

function formatWorkspaceRootRelativePath(rootId: string, relativePath: string | null) {
  const normalizedRootId = String(rootId ?? "").trim();
  const normalizedRelativePath = normalizeWorkbenchPath(relativePath ?? "").replace(/^\/+/, "");
  return normalizedRelativePath ? `${normalizedRootId}:${normalizedRelativePath}` : `${normalizedRootId}:`;
}

function formatWorkspaceRootOpenPath(root: WorkspaceFileLinkRoot, relativePath: string | null, absolutePath: string) {
  const mode = root.openPathMode ?? "workspace-qualified";
  const normalizedRelativePath = normalizeWorkbenchPath(relativePath ?? "").replace(/^\/+/, "");
  if (mode === "absolute") {
    const normalizedAbsolutePath = normalizeWorkbenchPath(absolutePath);
    if (normalizedAbsolutePath) {
      return normalizedAbsolutePath;
    }

    const normalizedRootPath = normalizeWorkbenchPath(root.rootPath);
    return normalizedRelativePath ? `${normalizedRootPath}/${normalizedRelativePath}` : normalizedRootPath;
  }

  return mode === "root-relative"
    ? normalizedRelativePath
    : formatWorkspaceRootRelativePath(root.id, normalizedRelativePath);
}

function parseWorkspaceRootRelativePath(value: string) {
  const parsedValue = parseProjectFileLinkLocation(value);
  const normalizedPath = normalizeWorkbenchPath(parsedValue.path).replace(/^\.\//, "");
  const separatorIndex = normalizedPath.indexOf(":");
  if (separatorIndex <= 0 || /^[A-Za-z]:\//.test(normalizedPath)) {
    return null;
  }

  return {
    columnNumber: parsedValue.columnNumber,
    lineNumber: parsedValue.lineNumber,
    relativePath: normalizedPath.slice(separatorIndex + 1).replace(/^\/+/, ""),
    rootId: normalizedPath.slice(0, separatorIndex),
  };
}

function findWorkspaceRootById(workspaceRoots: readonly WorkspaceFileLinkRoot[], rootId: string) {
  const comparableRootId = rootId.toLowerCase();
  return workspaceRoots.find((root) => root.id.toLowerCase() === comparableRootId) ?? null;
}

function findWorkspaceRootByPath(workspaceRoots: readonly WorkspaceFileLinkRoot[], absolutePath: string) {
  const normalizedAbsolutePath = normalizeWorkbenchPath(absolutePath);
  if (!normalizedAbsolutePath) {
    return null;
  }

  let bestMatch: { relativePath: string | null; root: WorkspaceFileLinkRoot } | null = null;
  for (const root of workspaceRoots) {
    const relativePath = toProjectRelativeFilePath(normalizedAbsolutePath, root.rootPath);
    if (relativePath === null) {
      continue;
    }

    if (!bestMatch || normalizeWorkbenchPath(root.rootPath).length > normalizeWorkbenchPath(bestMatch.root.rootPath).length) {
      bestMatch = { relativePath, root };
    }
  }

  return bestMatch;
}

function resolveWorkspaceAbsoluteFileLinkTarget(
  absoluteTarget: NonNullable<ReturnType<typeof parseCodexFileLinkHref>>,
  workspaceRoots: readonly WorkspaceFileLinkRoot[],
): ProjectFileLinkTarget | null {
  const rootMatch = findWorkspaceRootByPath(workspaceRoots, absoluteTarget.absolutePath);
  return rootMatch
    ? {
      absolutePath: rootMatch.root.openPathMode === "absolute" ? absoluteTarget.absolutePath : null,
      columnNumber: absoluteTarget.columnNumber,
      exists: true,
      lineNumber: absoluteTarget.lineNumber,
      openPath: formatWorkspaceRootOpenPath(rootMatch.root, rootMatch.relativePath, absoluteTarget.absolutePath),
      projectId: rootMatch.root.projectId ?? null,
      relativePath: formatWorkspaceRootRelativePath(rootMatch.root.id, rootMatch.relativePath),
    }
    : null;
}

function resolveExplicitWorkspaceFileLinkTarget(
  value: string,
  workspaceRoots: readonly WorkspaceFileLinkRoot[],
): ProjectFileLinkTarget | null {
  const parsedValue = parseWorkspaceRootRelativePath(value);
  if (!parsedValue) {
    return null;
  }

  const root = findWorkspaceRootById(workspaceRoots, parsedValue.rootId);
  const openPath = root ? formatWorkspaceRootOpenPath(root, parsedValue.relativePath, "") : "";
  return root
    ? {
      absolutePath: root.openPathMode === "absolute" ? openPath : null,
      columnNumber: parsedValue.columnNumber,
      exists: true,
      lineNumber: parsedValue.lineNumber,
      openPath,
      projectId: root.projectId ?? null,
      relativePath: formatWorkspaceRootRelativePath(root.id, parsedValue.relativePath),
    }
    : null;
}

function resolvePreferredWorkspaceRootFileLinkTarget(
  value: string,
  candidatePaths: readonly string[],
  threadCwdPath: string,
  workspaceRoots: readonly WorkspaceFileLinkRoot[],
  {
    allowWithoutCandidate,
  }: {
    allowWithoutCandidate: boolean;
  },
): ProjectFileLinkTarget | null {
  const rootMatch = findWorkspaceRootByPath(workspaceRoots, threadCwdPath);
  if (!rootMatch) {
    return null;
  }

  const parsedValue = parseProjectFileLinkLocation(value);
  const normalizedPath = normalizeWorkbenchPath(parsedValue.path).replace(/^\.\//, "");
  if (!normalizedPath || normalizedPath.startsWith("../") || normalizedPath.includes(":")) {
    return null;
  }

  const cwdRootRelativePath = normalizeWorkbenchPath(rootMatch.relativePath ?? "").replace(/^\/+/, "");
  const targetRootRelativePath = cwdRootRelativePath
    ? normalizeWorkbenchPath(`${cwdRootRelativePath}/${normalizedPath}`)
    : normalizedPath;
  const candidatePath = formatWorkspaceRootRelativePath(rootMatch.root.id, targetRootRelativePath);
  const openPath = formatWorkspaceRootOpenPath(rootMatch.root, targetRootRelativePath, "");
  const comparableCandidatePath = normalizeComparableProjectPath(candidatePath);
  const exists = getUniqueCandidatePaths(candidatePaths).some((filePath) => normalizeComparableProjectPath(filePath) === comparableCandidatePath);
  return allowWithoutCandidate || exists
    ? {
      absolutePath: rootMatch.root.openPathMode === "absolute" ? openPath : null,
      columnNumber: parsedValue.columnNumber,
      exists,
      lineNumber: parsedValue.lineNumber,
      openPath,
      projectId: rootMatch.root.projectId ?? null,
      relativePath: candidatePath,
    }
    : null;
}

function getUniqueCandidatePaths(candidatePaths: readonly string[]) {
  const cachedPaths = uniqueCandidatePathsCache.get(candidatePaths);
  if (cachedPaths) {
    return cachedPaths;
  }

  const pathsByComparablePath = new Map<string, string>();
  for (const candidatePath of candidatePaths) {
    const normalizedPath = normalizeWorkbenchPath(candidatePath);
    if (!normalizedPath) {
      continue;
    }

    pathsByComparablePath.set(normalizeComparableProjectPath(normalizedPath), normalizedPath);
  }

  const uniquePaths = Array.from(pathsByComparablePath.values());
  uniqueCandidatePathsCache.set(candidatePaths, uniquePaths);
  return uniquePaths;
}

function resolveRelativeProjectFileLinkTarget(
  value: string,
  candidatePaths: readonly string[],
  {
    allowSuffixMatch,
  }: {
    allowSuffixMatch: boolean;
  },
): ProjectFileLinkTarget | null {
  const parsedValue = parseProjectFileLinkLocation(value);
  const normalizedPath = normalizeWorkbenchPath(parsedValue.path).replace(/^\.\//, "");
  if (!normalizedPath || normalizedPath.startsWith("../")) {
    return null;
  }

  const comparablePath = normalizeComparableProjectPath(normalizedPath);
  const candidates = getUniqueCandidatePaths(candidatePaths);
  const exactMatches = candidates.filter((candidatePath) => (
    normalizeComparableProjectPath(candidatePath) === comparablePath
  ));
  if (exactMatches.length === 1) {
    return {
      absolutePath: null,
      columnNumber: parsedValue.columnNumber,
      exists: true,
      lineNumber: parsedValue.lineNumber,
      openPath: exactMatches[0],
      projectId: null,
      relativePath: exactMatches[0],
    };
  }

  const workspaceRootRelativeMatches = candidates.filter((candidatePath) => {
    const parsedCandidatePath = parseWorkspaceRootRelativePath(candidatePath);
    return parsedCandidatePath
      ? normalizeComparableProjectPath(parsedCandidatePath.relativePath) === comparablePath
      : false;
  });
  if (workspaceRootRelativeMatches.length === 1) {
    return {
      absolutePath: null,
      columnNumber: parsedValue.columnNumber,
      exists: true,
      lineNumber: parsedValue.lineNumber,
      openPath: workspaceRootRelativeMatches[0],
      projectId: null,
      relativePath: workspaceRootRelativeMatches[0],
    };
  }

  if (!allowSuffixMatch) {
    return null;
  }

  const suffixMatches = candidates.filter((candidatePath) => (
    normalizeComparableProjectPath(candidatePath).endsWith(`/${comparablePath}`)
  ));
  return suffixMatches.length === 1
    ? {
      absolutePath: null,
      columnNumber: parsedValue.columnNumber,
      exists: true,
      lineNumber: parsedValue.lineNumber,
      openPath: suffixMatches[0],
      projectId: null,
      relativePath: suffixMatches[0],
    }
    : null;
}

function isCompleteProjectRelativeFilePath(value: string) {
  const normalizedPath = normalizeWorkbenchPath(value).replace(/^\.\//, "");
  if (
    !normalizedPath
    || normalizedPath.startsWith("../")
    || normalizedPath.includes(":")
    || /^(?:[A-Za-z]:\/|\/)/.test(normalizedPath)
    || !normalizedPath.includes("/")
    || normalizedPath.includes("*")
  ) {
    return false;
  }

  const fileName = normalizedPath.split("/").at(-1) ?? "";
  return /\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(fileName);
}

function resolveMissingProjectRelativeFileLinkTarget(value: string): ProjectFileLinkTarget | null {
  const parsedValue = parseProjectFileLinkLocation(value);
  const normalizedPath = normalizeWorkbenchPath(parsedValue.path).replace(/^\.\//, "");
  if (!isCompleteProjectRelativeFilePath(normalizedPath)) {
    return null;
  }

  return {
    absolutePath: null,
    columnNumber: parsedValue.columnNumber,
    exists: false,
    lineNumber: parsedValue.lineNumber,
    openPath: normalizedPath,
    projectId: null,
    relativePath: normalizedPath,
  };
}

export function resolveProjectFileLinkTarget(
  value: string,
  {
    allowSuffixMatch = true,
    candidatePaths = [],
    allowThreadCwdPathWithoutCandidate = false,
    threadCwdPath = "",
    projectRootPath = "",
    workspaceRoots = [],
  }: {
    allowThreadCwdPathWithoutCandidate?: boolean;
    allowSuffixMatch?: boolean;
    candidatePaths?: readonly string[];
    threadCwdPath?: string;
    projectRootPath?: string;
    workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  } = {},
): ProjectFileLinkTarget | null {
  const normalizedValue = normalizeMarkdownHref(value);
  const absoluteTarget = parseCodexFileLinkHref(normalizedValue);
  if (absoluteTarget) {
    const workspaceRelativePath = resolveWorkspaceAbsoluteFileLinkTarget(absoluteTarget, workspaceRoots);
    if (workspaceRelativePath) {
      return workspaceRelativePath;
    }

    const relativePath = toProjectRelativeFilePath(absoluteTarget.absolutePath, projectRootPath);
    return relativePath
      ? {
        absolutePath: null,
        columnNumber: absoluteTarget.columnNumber,
        exists: true,
        lineNumber: absoluteTarget.lineNumber,
        openPath: relativePath,
        projectId: null,
        relativePath,
      }
      : {
        absolutePath: absoluteTarget.absolutePath,
        columnNumber: absoluteTarget.columnNumber,
        exists: true,
        lineNumber: absoluteTarget.lineNumber,
        openPath: absoluteTarget.absolutePath,
        projectId: null,
        relativePath: absoluteTarget.absolutePath,
      };
  }

  const explicitWorkspaceTarget = resolveExplicitWorkspaceFileLinkTarget(normalizedValue, workspaceRoots);
  if (explicitWorkspaceTarget) {
    return explicitWorkspaceTarget;
  }

  const preferredWorkspaceTarget = resolvePreferredWorkspaceRootFileLinkTarget(
    normalizedValue,
    candidatePaths,
    threadCwdPath || projectRootPath,
    workspaceRoots,
    { allowWithoutCandidate: allowThreadCwdPathWithoutCandidate },
  );
  if (preferredWorkspaceTarget) {
    return preferredWorkspaceTarget;
  }

  const relativeTarget = resolveRelativeProjectFileLinkTarget(normalizedValue, candidatePaths, {
    allowSuffixMatch,
  });
  if (relativeTarget) {
    return relativeTarget;
  }

  return allowThreadCwdPathWithoutCandidate
    ? resolveMissingProjectRelativeFileLinkTarget(normalizedValue)
    : null;
}

export function appendCodexFileLinkLocation(label: string, href: string) {
  const parsedHref = parseCodexFileLinkHref(href);
  if (!parsedHref?.lineNumber) {
    return label;
  }

  const locationSuffix = `:${parsedHref.lineNumber}${parsedHref.columnNumber !== null ? `:${parsedHref.columnNumber}` : ""}`;
  return label.trimEnd().endsWith(locationSuffix)
    ? label
    : `${label}${locationSuffix}`;
}

export function toProjectRelativeFilePath(absolutePath: string, projectRootPath: string) {
  const normalizedAbsolutePath = normalizeWorkbenchPath(absolutePath);
  const normalizedProjectRootPath = normalizeWorkbenchPath(projectRootPath);
  if (!normalizedAbsolutePath || !normalizedProjectRootPath) {
    return null;
  }

  const comparableAbsolutePath = isWindowsAbsolutePath(normalizedAbsolutePath)
    ? normalizedAbsolutePath.toLowerCase()
    : normalizedAbsolutePath;
  const comparableProjectRootPath = isWindowsAbsolutePath(normalizedProjectRootPath)
    ? normalizedProjectRootPath.toLowerCase()
    : normalizedProjectRootPath;

  if (
    comparableAbsolutePath !== comparableProjectRootPath
    && !comparableAbsolutePath.startsWith(`${comparableProjectRootPath}/`)
  ) {
    return null;
  }

  return normalizedAbsolutePath.slice(normalizedProjectRootPath.length).replace(/^\/+/, "") || null;
}

export function toWorkbenchDisplayPath(path: string, projectRootPath: string) {
  const normalizedPath = normalizeWorkbenchPath(String(path ?? "").trim());
  if (!normalizedPath) {
    return null;
  }

  const projectRelativePath = toProjectRelativeFilePath(normalizedPath, projectRootPath);
  if (projectRelativePath) {
    return projectRelativePath;
  }

  const normalizedProjectRootPath = normalizeWorkbenchPath(projectRootPath);
  if (normalizedProjectRootPath) {
    const comparablePath = isWindowsAbsolutePath(normalizedPath)
      ? normalizedPath.toLowerCase()
      : normalizedPath;
    const comparableProjectRootPath = isWindowsAbsolutePath(normalizedProjectRootPath)
      ? normalizedProjectRootPath.toLowerCase()
      : normalizedProjectRootPath;
    const rootIndex = comparablePath.indexOf(`${comparableProjectRootPath}/`);
    if (rootIndex >= 0) {
      return normalizedPath.slice(rootIndex + normalizedProjectRootPath.length + 1).replace(/^\/+/, "") || ".";
    }
  }

  return normalizedPath;
}

export function toWorkspaceDisplayPath(
  filePath: string,
  {
    projectRootPath = "",
    workspaceRoots = [],
  }: {
    projectRootPath?: string;
    workspaceRoots?: readonly WorkspaceFileLinkRoot[];
  } = {},
) {
  const normalizedPath = normalizeWorkbenchPath(String(filePath ?? "").trim());
  if (!normalizedPath) {
    return null;
  }

  const workspaceRootMatch = findWorkspaceRootByPath(workspaceRoots, normalizedPath);
  if (workspaceRootMatch) {
    return formatWorkspaceRootRelativePath(workspaceRootMatch.root.id, workspaceRootMatch.relativePath);
  }

  return toWorkbenchDisplayPath(normalizedPath, projectRootPath);
}
