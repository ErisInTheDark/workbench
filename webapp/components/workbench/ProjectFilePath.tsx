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
};

export default function ProjectFilePath ({
  className,
  columnNumber,
  interactive = false,
  label,
  lineNumber,
  path,
}: ProjectFilePathProps) {
  const display = getProjectFilePathDisplay(path, { columnNumber, label, lineNumber });

  return (
    <span
      className={joinClasses(
        projectFilePathPillClassName,
        interactive && projectFilePathInteractiveClassName,
        className,
      )}
      title={display.title}
    >
      <span className={projectFilePathLabelClassName}>{display.label}</span>
      {display.locationSuffix ? (
        <span className={projectFilePathLocationClassName}>{display.locationSuffix}</span>
      ) : null}
    </span>
  );
}
