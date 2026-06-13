"use client";

import {
  getProjectFilePathDisplay,
  projectFilePathInteractiveClassName,
  projectFilePathLabelClassName,
  projectFilePathLocationClassName,
  projectFilePathPillClassName,
  type ProjectFilePathDisplayOptions,
} from "../../lib/workbench/project/project-file-path";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ProjectFilePathProps = ProjectFilePathDisplayOptions & {
  className?: string;
  interactive?: boolean;
  path: string;
  projectId?: string | null;
};

export default function ProjectFilePath ({
  className,
  columnNumber,
  disambiguationPaths,
  interactive = false,
  label,
  lineNumber,
  path,
  projectId = null,
}: ProjectFilePathProps) {
  const display = getProjectFilePathDisplay(path, { columnNumber, disambiguationPaths, label, lineNumber });
  const isFileControl = typeof projectId === "string" && projectId.trim().length > 0;
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
    (interactive || isFileControl) && projectFilePathInteractiveClassName,
    className,
  );

  if (isFileControl) {
    return (
      <button
        type="button"
        className={joinClasses(controlClassName, "border-0 text-left")}
        data-project-file-column-number={columnNumber ?? undefined}
        data-project-file-line-number={lineNumber ?? undefined}
        data-project-file-relative-path={path}
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
        interactive && projectFilePathInteractiveClassName,
        className,
      )}
      title={display.title}
    >
      {content}
    </span>
  );
}
