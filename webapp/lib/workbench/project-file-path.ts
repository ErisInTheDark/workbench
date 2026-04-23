/*
 * Exports:
 * - ProjectFilePathLocation: optional line and column metadata for displayed project paths. Keywords: project path, line, column.
 * - ProjectFilePathDisplay: derived label, basename, title, and location suffix for a project path pill. Keywords: project path, display, basename.
 * - ProjectFilePathDisplayOptions: optional label override plus line and column metadata for project path pills. Keywords: project path, label, line, column.
 * - projectFilePathPillClassName: shared rounded pill classes for project path rendering. Keywords: project path, pill, classes.
 * - projectFilePathInteractiveClassName: shared interactive hover/focus classes for clickable project path pills. Keywords: project path, interactive, classes.
 * - projectFilePathLabelClassName: shared classes for the visible filename text. Keywords: project path, label, classes.
 * - projectFilePathLocationClassName: shared low-contrast classes for line and column suffixes. Keywords: project path, location, classes.
 * - getProjectFilePathDisplay: derive the visible filename, tooltip path, and location suffix for a project-relative path. Keywords: project path, display, tooltip.
 */

import { normalizeWorkbenchPath } from "./markdown-links";

export interface ProjectFilePathLocation {
  columnNumber?: number | null;
  lineNumber?: number | null;
}

export interface ProjectFilePathDisplay {
  fileName: string;
  label: string;
  locationSuffix: string;
  title: string;
}

export interface ProjectFilePathDisplayOptions extends ProjectFilePathLocation {
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

export function getProjectFilePathDisplay(
  path: string,
  {
    label = null,
    columnNumber = null,
    lineNumber = null,
  }: ProjectFilePathDisplayOptions = {},
): ProjectFilePathDisplay {
  const normalizedPath = normalizeWorkbenchPath(path);
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  const fileName = pathSegments[pathSegments.length - 1] || normalizedPath || path;
  const locationSuffix = lineNumber === null
    ? ""
    : `:${lineNumber}${columnNumber === null ? "" : `:${columnNumber}`}`;

  return {
    fileName,
    label: label ?? fileName,
    locationSuffix,
    title: normalizedPath || path,
  };
}
