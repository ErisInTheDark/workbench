/*
 * Exports:
 * - default WorkbenchProjectLabel: render one canonical project icon, name, and relative-path label, and own compact/full multi-root path derivation. Keywords: project, icon, name, path, workspace, sidebar, thread.
 */

import type { WorkbenchProjectOption } from "../../lib/types";
import { workbenchThreadListLabelClassName } from "./workbench-class-names";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";

function getWorkbenchProjectDisplayPath(project: WorkbenchProjectOption) {
  const relativePath = project.relativePath || project.id || ".";
  return project.kind === "workspace"
    ? `${relativePath} · ${project.roots.length} roots`
    : relativePath;
}

function getWorkbenchProjectFullPath(project: WorkbenchProjectOption) {
  return project.kind === "workspace"
    ? project.roots.map((root) => `${root.id}: ${root.rootPath}`).join("\n")
    : project.rootPath;
}

const WorkbenchProjectLabel = Object.assign(function WorkbenchProjectLabel({
  active = false,
  project,
  variant = "card",
}: {
  active?: boolean;
  project: WorkbenchProjectOption;
  variant?: "card" | "heading" | "thread";
}) {
  const projectName = `${project.name || project.id}${project.kind === "workspace" ? " workspace" : ""}`;
  if (variant === "thread") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 leading-tight" title={getWorkbenchProjectFullPath(project)}>
        <WorkbenchProjectIcon project={project} variant="thread" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 text-[0.68rem] font-medium text-[color-mix(in_srgb,var(--text)_72%,transparent)]">{projectName}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[0.64rem] font-normal text-muted">{getWorkbenchProjectDisplayPath(project)}</span>
        </span>
      </span>
    );
  }
  if (variant === "heading") {
    return (
      <span className="flex min-w-0 items-center gap-2 leading-tight" title={getWorkbenchProjectFullPath(project)}>
        <WorkbenchProjectIcon project={project} variant="heading" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 truncate text-[1.05rem] font-semibold text-text">{projectName}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[0.78rem] font-normal text-muted">{getWorkbenchProjectDisplayPath(project)}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <WorkbenchProjectIcon project={project} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={`${workbenchThreadListLabelClassName} shrink-0 text-text${active ? " font-semibold" : ""}`}>{projectName}</span>
        {project.kind === "workbench-library" ? null : (
          <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] font-normal text-muted">{getWorkbenchProjectDisplayPath(project)}</span>
        )}
      </span>
    </span>
  );
}, {
  getDisplayPath: getWorkbenchProjectDisplayPath,
  getFullPath: getWorkbenchProjectFullPath,
});

export default WorkbenchProjectLabel;
