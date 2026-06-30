/*
 * Exports:
 * - ProjectFilePathDisplayProvider: provide a project-owned disambiguation index to nested path pills. Keywords: project path, cache, context.
 * - default ProjectFilePath: render a project-relative file path pill or file-open button. Keywords: project path, display, button.
 */
"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  getProjectFilePathDisplay,
  projectFilePathInteractiveClassName,
  projectFilePathLabelClassName,
  projectFilePathLocationClassName,
  projectFilePathMissingClassName,
  projectFilePathPillClassName,
  projectFilePathStaticClassName,
  type ProjectFilePathDisambiguationIndex,
  type ProjectFilePathDisplayOptions,
} from "../../lib/workbench/project/project-file-path";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

interface ProjectFilePathDisplayContextValue {
  disambiguationIndex?: ProjectFilePathDisambiguationIndex | null;
  disambiguationKey?: string;
  disambiguationPaths?: readonly string[];
}

type ProjectFilePathProps = ProjectFilePathDisplayOptions & {
  absolutePath?: string | null;
  className?: string;
  exists?: boolean;
  interactive?: boolean;
  openPath?: string | null;
  path: string;
  projectId?: string | null;
  targetType?: "directory" | "file";
};

const ProjectFilePathDisplayContext = createContext<ProjectFilePathDisplayContextValue | null>(null);

export function ProjectFilePathDisplayProvider ({
  children,
  disambiguationIndex,
  disambiguationKey,
  disambiguationPaths,
}: {
  children: ReactNode;
  disambiguationIndex?: ProjectFilePathDisambiguationIndex | null;
  disambiguationKey?: string;
  disambiguationPaths?: readonly string[];
}) {
  const value = useMemo(() => ({
    disambiguationIndex,
    disambiguationKey,
    disambiguationPaths,
  }), [disambiguationIndex, disambiguationKey, disambiguationPaths]);

  return (
    <ProjectFilePathDisplayContext.Provider value={value}>
      {children}
    </ProjectFilePathDisplayContext.Provider>
  );
}

export default function ProjectFilePath ({
  absolutePath = null,
  className,
  columnNumber,
  disambiguationIndex,
  disambiguationKey,
  disambiguationPaths,
  exists = true,
  interactive = false,
  label,
  lineNumber,
  openPath = null,
  path,
  projectId = null,
  targetType = "file",
}: ProjectFilePathProps) {
  const context = useContext(ProjectFilePathDisplayContext);
  const usesInheritedDisambiguation = Boolean(
    context
    && disambiguationIndex === undefined
    && (disambiguationPaths === undefined || context.disambiguationPaths === disambiguationPaths),
  );
  const resolvedDisambiguationPaths = disambiguationPaths ?? (
    usesInheritedDisambiguation
      ? context?.disambiguationPaths
      : undefined
  );
  const resolvedDisambiguationIndex = disambiguationIndex !== undefined
    ? disambiguationIndex
    : usesInheritedDisambiguation
      ? context?.disambiguationIndex ?? null
      : undefined;
  const display = getProjectFilePathDisplay(path, {
    columnNumber,
    disambiguationIndex: resolvedDisambiguationIndex,
    disambiguationKey: disambiguationKey ?? (usesInheritedDisambiguation ? context?.disambiguationKey : undefined),
    disambiguationPaths: resolvedDisambiguationPaths,
    label,
    lineNumber,
    targetType,
  });
  const isFileControl = targetType === "file" && (
    (typeof projectId === "string" && projectId.trim().length > 0)
    || (typeof absolutePath === "string" && absolutePath.trim().length > 0)
  );
  const content = (
    <>
      {display.rootPrefix ? (
        <span className={projectFilePathLocationClassName}>{display.rootPrefix}</span>
      ) : null}
      <span className={projectFilePathLabelClassName}>{display.label}</span>
      {display.locationSuffix ? (
        <span className={projectFilePathLocationClassName}>{display.locationSuffix}</span>
      ) : null}
    </>
  );

  const controlClassName = joinClasses(
    projectFilePathPillClassName,
    !exists && projectFilePathMissingClassName,
    exists && targetType === "directory" && projectFilePathStaticClassName,
    exists && (interactive || isFileControl) && projectFilePathInteractiveClassName,
    className,
  );

  if (exists && isFileControl) {
    return (
      <button
        type="button"
        className={joinClasses(controlClassName, "border-0 text-left")}
        data-project-file-column-number={columnNumber ?? undefined}
        data-project-file-line-number={lineNumber ?? undefined}
        data-project-file-project-id={projectId}
        data-project-file-absolute-path={absolutePath ?? undefined}
        data-project-file-relative-path={openPath ?? path}
        data-thread-summary-action="true"
        title={display.title}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={joinClasses(
        projectFilePathPillClassName,
        !exists && projectFilePathMissingClassName,
        exists && targetType === "directory" && projectFilePathStaticClassName,
        exists && interactive && projectFilePathInteractiveClassName,
        className,
      )}
      data-project-file-missing-path={exists ? undefined : "true"}
      data-project-folder-path={exists && targetType === "directory" ? "true" : undefined}
      title={display.title}
    >
      {content}
    </span>
  );
}
