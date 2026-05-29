/*
 * Exports:
 * - buildCommandPathPart: resolve a raw path into a project-relative path part for command summaries. Keywords: thread, command, path, relative.
 * - buildDisplayPathPart: turn a display path into a labeled command-summary path part. Keywords: thread, command, path, label.
 * - collapseWhitespace: normalize whitespace in command text for compact summaries. Keywords: thread, command, whitespace.
 * - createEmptyCommandSummaryStats: build a zeroed aggregate-summary counter object. Keywords: thread, command, summary, aggregate.
 * - mergeCommandSummaryStats: add aggregate command-summary counters together. Keywords: thread, command, summary, aggregate.
 * - countKnownCommandSummaryStats: total the categorized command-summary counters without the other bucket. Keywords: thread, command, summary, aggregate.
 * - getCommandPathKnownSkill: resolve a command path to a known Workbench Skill when it targets SKILL.md. Keywords: command, skill, path.
 * - formatThreadCommandPath: resolve command paths into project-relative forward-slash display text. Keywords: path, command, relative, display.
 * - summarizeDisplayParts: flatten structured command-summary parts into plain text. Keywords: thread, command, summary, text.
 */

import {
    normalizeWorkbenchPath,
    toProjectRelativeFilePath,
} from "../../markdown/markdown-links";
import type {
    CommandPathDisplayPart,
    ParsedCommandDisplayContext,
    ThreadCommandDisplayPart,
    ThreadCommandSummaryStats,
} from "./types";

interface PathPartOptions {
  columnNumber?: number | null;
  labelMode?: "basename" | "path";
  lineNumber?: number | null;
}

export function buildDisplayPathPart(
  path: string | null | undefined,
  {
    columnNumber = null,
    labelMode = "basename",
    lineNumber = null,
  }: PathPartOptions = {},
): CommandPathDisplayPart | null {
  const normalizedPath = normalizeWorkbenchPath(String(path ?? "").trim());
  if (!normalizedPath) {
    return null;
  }

  return {
    columnNumber,
    label: labelMode === "path" ? normalizedPath : undefined,
    lineNumber,
    path: normalizedPath,
    type: "path",
  } satisfies CommandPathDisplayPart;
}

export function buildCommandPathPart(
  value: string | null | undefined,
  context: Pick<ParsedCommandDisplayContext, "cwd" | "projectRootPath">,
  options: PathPartOptions = {},
) {
  const displayPath = formatThreadCommandPath(value, context);
  return buildDisplayPathPart(displayPath, options);
}

export function collapseWhitespace(value: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function createEmptyCommandSummaryStats(): ThreadCommandSummaryStats {
  return {
    deletedPaths: 0,
    gitDiffChecks: 0,
    gitStatusChecks: 0,
    listedFiles: 0,
    otherCommands: 0,
    pathChecks: 0,
    readFiles: 0,
    searchedFiles: 0,
    skillLoads: 0,
    typescriptBuilds: 0,
    typescriptValidations: 0,
    webRequests: 0,
  };
}

export function mergeCommandSummaryStats(
  target: ThreadCommandSummaryStats,
  source?: Partial<ThreadCommandSummaryStats> | null,
) {
  if (!source) {
    return target;
  }

  for (const key of Object.keys(target) as Array<keyof ThreadCommandSummaryStats>) {
    const value = source[key];
    if (!value) {
      continue;
    }

    target[key] += value;
  }

  return target;
}

export function countKnownCommandSummaryStats(stats: ThreadCommandSummaryStats) {
  return stats.readFiles
    + stats.deletedPaths
    + stats.skillLoads
    + stats.searchedFiles
    + stats.listedFiles
    + stats.gitDiffChecks
    + stats.gitStatusChecks
    + stats.pathChecks
    + stats.typescriptBuilds
    + stats.typescriptValidations
    + stats.webRequests;
}

export function summarizeDisplayParts(parts: ThreadCommandDisplayPart[]) {
  return parts.map((part) => {
    if (part.type === "separator") {
      return " -> ";
    }

    if (part.type === "path") {
      const pathLabel = part.label ?? part.path;
      return `${pathLabel}${part.lineNumber !== null && part.lineNumber !== undefined ? `:${part.lineNumber}` : ""}${part.columnNumber !== null && part.columnNumber !== undefined ? `:${part.columnNumber}` : ""}`;
    }

    if (part.type === "skill") {
      return `/${part.name}`;
    }

    return part.text;
  }).join("");
}

export function getCommandPathKnownSkill(
  value: string | null | undefined,
  {
    cwd,
    knownSkills,
  }: Pick<ParsedCommandDisplayContext, "cwd" | "knownSkills">,
) {
  const normalizedValue = normalizeWorkbenchPath(String(value ?? "").trim());
  if (!normalizedValue || !knownSkills?.length) {
    return null;
  }

  const resolvedValue = isAbsoluteLocalPath(normalizedValue)
    ? collapseLocalPath(normalizedValue)
    : cwd
      ? collapseLocalPath(joinLocalPath(cwd, normalizedValue))
      : collapseLocalPath(normalizedValue);
  const comparableResolvedValue = normalizeComparablePath(resolvedValue);

  return knownSkills.find((skill) => normalizeComparablePath(skill.path) === comparableResolvedValue) ?? null;
}

export function buildReadCommandSummary(
  value: string | null | undefined,
  context: Pick<ParsedCommandDisplayContext, "cwd" | "knownSkills" | "projectRootPath">,
  readPrefix = "Read ",
) {
  const knownSkill = getCommandPathKnownSkill(value, context);
  if (knownSkill) {
    return {
      summaryParts: [
        { text: "Load ", type: "text", variant: "plain" },
        { name: knownSkill.name, path: knownSkill.path, type: "skill" },
      ] satisfies ThreadCommandDisplayPart[],
      summaryStats: { skillLoads: 1 },
    };
  }

  const pathPart = buildCommandPathPart(value, context);
  if (!pathPart) {
    return null;
  }

  return {
    pathPart,
    summaryParts: [
      { text: readPrefix, type: "text", variant: "plain" },
      pathPart,
    ] satisfies ThreadCommandDisplayPart[],
    summaryStats: { readFiles: 1 },
  };
}

export function formatThreadCommandPath(
  value: string | null | undefined,
  {
    cwd,
    projectRootPath,
  }: {
    cwd?: string;
    projectRootPath?: string;
  } = {},
) {
  const normalizedValue = normalizeWorkbenchPath(String(value ?? "").trim());
  if (!normalizedValue) {
    return null;
  }

  const resolvedValue = isAbsoluteLocalPath(normalizedValue)
    ? collapseLocalPath(normalizedValue)
    : cwd
      ? collapseLocalPath(joinLocalPath(cwd, normalizedValue))
      : collapseLocalPath(normalizedValue);
  const normalizedProjectRootPath = normalizeWorkbenchPath(projectRootPath ?? "");

  if (normalizedProjectRootPath) {
    if (pathsEqual(resolvedValue, normalizedProjectRootPath)) {
      return ".";
    }

    const relativePath = toProjectRelativeFilePath(resolvedValue, normalizedProjectRootPath);
    if (relativePath) {
      return relativePath;
    }
  }

  if (isAbsoluteLocalPath(normalizedValue)) {
    return resolvedValue;
  }

  const cleanedRelativePath = collapseLocalPath(normalizedValue).replace(/^\.\//, "");
  return cleanedRelativePath === "." ? "." : cleanedRelativePath;
}

function isAbsoluteLocalPath(value: string) {
  return /^[A-Za-z]:\//.test(value) || value.startsWith("/");
}

function pathsEqual(left: string, right: string) {
  const normalizedLeft = normalizeWorkbenchPath(left);
  const normalizedRight = normalizeWorkbenchPath(right);

  if (/^[A-Za-z]:\//.test(normalizedLeft) || /^[A-Za-z]:\//.test(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

function normalizeComparablePath(value: string) {
  const normalizedValue = normalizeWorkbenchPath(value);
  return /^[A-Za-z]:\//.test(normalizedValue)
    ? normalizedValue.toLowerCase()
    : normalizedValue;
}

function collapseLocalPath(value: string) {
  const normalizedValue = normalizeWorkbenchPath(value);
  const windowsMatch = normalizedValue.match(/^([A-Za-z]:)(\/.*)?$/);
  const isWindowsAbsolute = Boolean(windowsMatch);
  const isUnixAbsolute = !isWindowsAbsolute && normalizedValue.startsWith("/");
  const prefix = windowsMatch
    ? `${windowsMatch[1]}/`
    : isUnixAbsolute
      ? "/"
      : "";
  const remainder = windowsMatch?.[2] ?? (isUnixAbsolute ? normalizedValue.slice(1) : normalizedValue);
  const segments = remainder.split("/").filter(Boolean);
  const stack: string[] = [];

  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (stack.length && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!prefix) {
        stack.push("..");
      }
      continue;
    }

    stack.push(segment);
  }

  const collapsedRemainder = stack.join("/");
  if (!prefix) {
    return collapsedRemainder || ".";
  }

  return collapsedRemainder ? `${prefix}${collapsedRemainder}` : prefix.replace(/\/$/, "");
}

function joinLocalPath(base: string, relativePath: string) {
  const normalizedBase = normalizeWorkbenchPath(base);
  const normalizedRelativePath = normalizeWorkbenchPath(relativePath);
  if (!normalizedBase) {
    return normalizedRelativePath;
  }

  return `${normalizedBase.replace(/\/+$/, "")}/${normalizedRelativePath.replace(/^\.?\//, "")}`;
}
