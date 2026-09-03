/*
 * Exports:
 * - WorkbenchAgentPathKind/WorkbenchAgentPath: parsed canonical Workbench agent path shape. Keywords: agent, path, canonical.
 * - normalizeWorkbenchAgentPath: normalize supported library and project agent paths, rejecting legacy absolute paths. Keywords: agent, normalize, storage.
 * - getWorkbenchAgentPathLabel: derive a compact display label from a canonical agent path. Keywords: agent, label, display.
 * - isWorkbenchLibraryAgentPath/isWorkbenchProjectAgentPath/areWorkbenchAgentPathsEqual: classify and compare canonical agent paths. Keywords: agent, path, compare.
 */

export type WorkbenchAgentPathKind = "library" | "project";

export interface WorkbenchAgentPath {
  readonly kind: WorkbenchAgentPathKind;
  readonly value: string;
}

const LIBRARY_AGENT_PREFIX = "library:";
const LIBRARY_AGENT_DIRECTORY = "agents/";
const PROJECT_AGENT_DIRECTORY = ".agents/agents/";
const MARKDOWN_FILE_SUFFIX = ".md";
const TEMPLATE_MARKDOWN_FILE_SUFFIX = ".template.md";

function normalizePathText(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function hasSafeRelativeParts(value: string) {
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

function isRelativeMarkdownAgentPath(value: string) {
  return hasSafeRelativeParts(value)
    && value.endsWith(MARKDOWN_FILE_SUFFIX)
    && !value.endsWith(TEMPLATE_MARKDOWN_FILE_SUFFIX);
}

function parseWorkbenchAgentPath(value: string | null | undefined): WorkbenchAgentPath | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedPath = normalizePathText(value);
  if (
    !normalizedPath
    || normalizedPath.startsWith("/")
    || /^[a-z]:\//iu.test(normalizedPath)
  ) {
    return null;
  }

  const hasLibraryPrefix = normalizedPath.startsWith(LIBRARY_AGENT_PREFIX);
  const pathWithoutLibraryPrefix = hasLibraryPrefix
    ? normalizedPath.slice(LIBRARY_AGENT_PREFIX.length).replace(/^\/+/, "")
    : normalizedPath;

  if (!isRelativeMarkdownAgentPath(pathWithoutLibraryPrefix)) {
    return null;
  }

  if (pathWithoutLibraryPrefix.startsWith(LIBRARY_AGENT_DIRECTORY)) {
    return {
      kind: "library",
      value: `${LIBRARY_AGENT_PREFIX}${pathWithoutLibraryPrefix}`,
    };
  }

  if (!hasLibraryPrefix && pathWithoutLibraryPrefix.startsWith(PROJECT_AGENT_DIRECTORY)) {
    return {
      kind: "project",
      value: pathWithoutLibraryPrefix,
    };
  }

  return null;
}

export function normalizeWorkbenchAgentPath(value: string | null | undefined) {
  return parseWorkbenchAgentPath(value)?.value ?? null;
}

export function getWorkbenchAgentPathLabel(value: string | null | undefined) {
  const normalizedPath = normalizeWorkbenchAgentPath(value);
  if (!normalizedPath) {
    return null;
  }

  const withoutLibraryPrefix = normalizedPath.startsWith(LIBRARY_AGENT_PREFIX)
    ? normalizedPath.slice(LIBRARY_AGENT_PREFIX.length)
    : normalizedPath;
  const fileName = withoutLibraryPrefix.split("/").at(-1) ?? "";
  return fileName.replace(/\.md$/iu, "") || null;
}

export function isWorkbenchLibraryAgentPath(value: string | null | undefined) {
  return parseWorkbenchAgentPath(value)?.kind === "library";
}

export function isWorkbenchProjectAgentPath(value: string | null | undefined) {
  return parseWorkbenchAgentPath(value)?.kind === "project";
}

export function areWorkbenchAgentPathsEqual(left: string | null | undefined, right: string | null | undefined) {
  return normalizeWorkbenchAgentPath(left) === normalizeWorkbenchAgentPath(right);
}
