"use client";

import {
  getProjectFilePathDisplay,
  projectFilePathInteractiveClassName,
  projectFilePathLabelClassName,
  projectFilePathLocationClassName,
  projectFilePathPillClassName,
  type ProjectFilePathDisplayOptions,
} from "../../lib/workbench/project/project-file-path";
import { createFileHref } from "../../lib/workbench/navigation/workbench-route";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function appendLocationToFileHref(href: string, {
  columnNumber = null,
  lineNumber = null,
}: {
  columnNumber?: number | null;
  lineNumber?: number | null;
}) {
  if (lineNumber === null) {
    return href;
  }

  const separator = href.includes("?") ? "&" : "?";
  const columnSearch = columnNumber === null ? "" : `&column=${encodeURIComponent(String(columnNumber))}`;
  return `${href}${separator}line=${encodeURIComponent(String(lineNumber))}${columnSearch}`;
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
  const isLink = projectId !== null;
  const content = (
    <>
      <span className={projectFilePathLabelClassName}>{display.label}</span>
      {display.locationSuffix ? (
        <span className={projectFilePathLocationClassName}>{display.locationSuffix}</span>
      ) : null}
    </>
  );

  const linkClassName = joinClasses(
    projectFilePathPillClassName,
    (interactive || isLink) && projectFilePathInteractiveClassName,
    className,
  );

  if (isLink) {
    return (
      <a
        className={linkClassName}
        data-project-file-column-number={columnNumber ?? undefined}
        data-project-file-line-number={lineNumber ?? undefined}
        data-project-file-relative-path={path}
        data-thread-summary-action="true"
        href={appendLocationToFileHref(createFileHref(projectId ?? "", path), { columnNumber, lineNumber })}
        title={display.title}
      >
        {content}
      </a>
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
