/*
 * Exports:
 * - normalizeWorkbenchPath: normalize local paths to forward-slash form for display and comparison. Keywords: path, normalize, local.
 * - normalizeMarkdownHref: unwrap markdown link destinations and normalize Windows absolute-path prefixes. Keywords: markdown, href, normalize.
 * - parseCodexFileLinkHref: parse absolute local file links with optional `:line[:column]` suffixes. Keywords: codex, file link, line number, column.
 * - appendCodexFileLinkLocation: append missing `:line[:column]` suffixes to codex file-link labels. Keywords: codex, file link, label, location.
 * - toProjectRelativeFilePath: convert an absolute local path into a project-relative path when it belongs to the current project root. Keywords: path, project root, relative.
 * - toWorkbenchDisplayPath: normalize a path for UI display and prefer project-relative forward-slash paths when possible. Keywords: path, display, project root.
 */

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
