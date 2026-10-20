/*
 * Exports:
 * - default ProjectFilePath: render a project-relative file path pill or file-open button, disambiguated and opened through
 *   the contextual project unless given its own paths or project. Keywords: project path, display, button.
 */
"use client";

import { useFile } from "../../workbench/file/use-file";

import {
  projectFilePathInteractiveClassName,
  projectFilePathLabelClassName,
  projectFilePathLocationClassName,
  projectFilePathMissingClassName,
  projectFilePathPillClassName,
  projectFilePathStaticClassName,
  type ProjectFilePathDisplayOptions,
} from "../../workbench/project/project-file-path";
import { useProject } from "./use-projects";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ProjectFilePathProps = ProjectFilePathDisplayOptions & {
  absolutePath?: string | null;
  className?: string;
  exists?: boolean;
  interactive?: boolean;
  /** Off when a Workbench tooltip describes the path instead; the browser's title would cover it. */
  nativeTitle?: boolean;
  openPath?: string | null;
  path: string;
  projectId?: string | null;
  targetType?: "directory" | "file";
};

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
  nativeTitle = true,
  openPath = null,
  path,
  projectId: givenProjectId,
  targetType = "file",
}: ProjectFilePathProps) {
  const project = useProject.contextual();
  const projectId = givenProjectId === undefined ? project?.id ?? null : givenProjectId;
  // Given paths are their own list; otherwise the contextual project's indexed file list disambiguates.
  const inherits = disambiguationIndex === undefined && disambiguationPaths === undefined;
  const { display, isFileControl, open } = useFile({
    absolutePath,
    columnNumber,
    displayOptions: {
      columnNumber,
      disambiguationIndex: inherits ? project?.pathDisambiguation?.index ?? null : disambiguationIndex,
      disambiguationKey: disambiguationKey ?? (inherits ? project?.pathDisambiguation?.key : undefined),
      disambiguationPaths: inherits ? project?.filePaths : disambiguationPaths,
      label,
      lineNumber,
      targetType,
    },
    lineNumber,
    openPath,
    path,
    projectId,
    targetType,
  });
  const title = nativeTitle ? display.title : undefined;
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
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          open();
        }}
        title={title}
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
      title={title}
    >
      {content}
    </span>
  );
}
