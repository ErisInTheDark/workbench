/*
 * Exports:
 * - default ProjectPicker: memoized sidebar project picker with recency and folder grouping. Keywords: project picker, sidebar, workspace.
 */
"use client";

import { forwardRef, memo, useMemo, type ForwardedRef, type KeyboardEvent, type MouseEvent } from "react";

import type { WorkbenchProjectOption } from "../../lib/types";
import { createProjectHref } from "../../lib/workbench/navigation/workbench-route";

interface ProjectGroup {
  label: string;
  projects: WorkbenchProjectOption[];
}

interface ProjectTimeGroup {
  folderGroups: ProjectGroup[];
  label: ProjectRecencyLabel;
}

interface GroupedProjects {
  libraryProjects: WorkbenchProjectOption[];
  timeGroups: ProjectTimeGroup[];
}

interface ProjectPickerProps {
  activeProjectId: string;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onProjectLinkClick(event: MouseEvent<HTMLAnchorElement>, projectId: string): void;
  projects: readonly WorkbenchProjectOption[];
}

const PROJECT_RECENCY_DAY_MS = 24 * 60 * 60 * 1000;
const PROJECT_RECENCY_BUCKETS = [
  { label: "last week", maxAgeMs: 7 * PROJECT_RECENCY_DAY_MS },
  { label: "last month", maxAgeMs: 31 * PROJECT_RECENCY_DAY_MS },
  { label: "last 3 months", maxAgeMs: 93 * PROJECT_RECENCY_DAY_MS },
  { label: "last 6 months", maxAgeMs: 186 * PROJECT_RECENCY_DAY_MS },
  { label: "last year", maxAgeMs: 366 * PROJECT_RECENCY_DAY_MS },
  { label: "ever", maxAgeMs: Number.POSITIVE_INFINITY },
] as const;

type ProjectRecencyLabel = typeof PROJECT_RECENCY_BUCKETS[number]["label"];

function getProjectDisplayPath(project: WorkbenchProjectOption) {
  const relativePath = project.relativePath || project.id || ".";
  if (project.kind === "workspace") {
    return `${relativePath} · ${project.roots.length} roots`;
  }

  return relativePath;
}

function getProjectGroupLabel(project: WorkbenchProjectOption) {
  const normalizedPath = (project.relativePath || project.id || ".").replace(/\\/g, "/").replace(/\/+$/u, "") || ".";
  if (normalizedPath === "." || !normalizedPath.includes("/")) {
    return ".";
  }

  return normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) || ".";
}

function getProjectTitle(project: WorkbenchProjectOption) {
  return project.kind === "workspace"
    ? project.roots.map((root) => `${root.id}: ${root.rootPath}`).join("\n")
    : project.rootPath;
}

function getProjectRecencyLabel(project: WorkbenchProjectOption, nowMs: number): ProjectRecencyLabel {
  if (project.lastCommitTimeMs === null) {
    return "ever";
  }

  const ageMs = Math.max(0, nowMs - project.lastCommitTimeMs);
  return PROJECT_RECENCY_BUCKETS.find((bucket) => ageMs <= bucket.maxAgeMs)?.label ?? "ever";
}

function getGroupedProjects(projects: readonly WorkbenchProjectOption[]): GroupedProjects {
  const libraryProjects: WorkbenchProjectOption[] = [];
  const nowMs = Date.now();
  const timeGroupsByLabel = new Map<ProjectRecencyLabel, ProjectTimeGroup>();
  const folderGroupsByTimeLabel = new Map<ProjectRecencyLabel, Map<string, ProjectGroup>>();

  for (const project of projects) {
    if (project.kind === "workbench-library") {
      libraryProjects.push(project);
      continue;
    }

    const timeLabel = getProjectRecencyLabel(project, nowMs);
    let timeGroup = timeGroupsByLabel.get(timeLabel);
    if (!timeGroup) {
      timeGroup = { label: timeLabel, folderGroups: [] };
      timeGroupsByLabel.set(timeLabel, timeGroup);
    }

    let folderGroupsByLabel = folderGroupsByTimeLabel.get(timeLabel);
    if (!folderGroupsByLabel) {
      folderGroupsByLabel = new Map<string, ProjectGroup>();
      folderGroupsByTimeLabel.set(timeLabel, folderGroupsByLabel);
    }

    const folderLabel = getProjectGroupLabel(project);
    const existingFolderGroup = folderGroupsByLabel.get(folderLabel);
    if (existingFolderGroup) {
      existingFolderGroup.projects.push(project);
      continue;
    }

    const folderGroup = { label: folderLabel, projects: [project] };
    folderGroupsByLabel.set(folderLabel, folderGroup);
    timeGroup.folderGroups.push(folderGroup);
  }

  const timeGroups = PROJECT_RECENCY_BUCKETS
    .map((bucket) => timeGroupsByLabel.get(bucket.label))
    .filter((group): group is ProjectTimeGroup => Boolean(group));

  return { libraryProjects, timeGroups };
}

function ProjectPicker(
  {
    activeProjectId,
    onKeyDown,
    onProjectLinkClick,
    projects,
  }: ProjectPickerProps,
  ref: ForwardedRef<HTMLDivElement>,
) {
  const groupedProjects = useMemo(() => getGroupedProjects(projects), [projects]);

  const renderProjectLink = (project: WorkbenchProjectOption) => {
    const isCurrentProject = project.id === activeProjectId;
    const projectSubtitle = getProjectDisplayPath(project);
    return (
      <a
        key={project.id}
        href={createProjectHref(project.id)}
        title={getProjectTitle(project)}
        className={`relative block min-w-0 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none md:py-1${isCurrentProject ? " text-accent after:absolute after:bottom-1 after:right-0 after:top-1 after:w-[2px] after:bg-accent" : " text-foreground/85"}`}
        onClick={(event) => {
          onProjectLinkClick(event, project.id);
        }}
      >
        <span className={`block truncate text-[0.94rem] leading-tight${isCurrentProject ? " font-semibold" : ""}`}>
          {project.name || project.id}{project.kind === "workspace" ? " workspace" : ""}
        </span>
        <span className="mt-1 block truncate font-mono text-[0.74rem] leading-tight text-current opacity-70">{projectSubtitle}</span>
      </a>
    );
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="explorer-scrollbar min-h-0 w-1/2 overflow-y-auto pb-8 pl-5 pr-2 focus:outline-none"
      onKeyDown={onKeyDown}
    >
      <section className="space-y-3 pr-2 md:pr-4.5">
        <nav aria-label="Projects" className="space-y-3">
          {groupedProjects.libraryProjects.length ? (
            <div className="space-y-1">
              {groupedProjects.libraryProjects.map((project) => renderProjectLink(project))}
            </div>
          ) : null}
          {groupedProjects.timeGroups.map((timeGroup) => (
            <section key={timeGroup.label} aria-label={`${timeGroup.label} projects`} className="space-y-2">
              <p className="m-0 mt-8 px-2 text-[1.24rem] font-semibold leading-tight opacity-50 italic flex items-center">
                <span className="block h-[1px] flex-1 bg-[currentcolor]/25" />
                <span className="block mx-4">{timeGroup.label}</span>
                <span className="block h-[1px] flex-1 bg-[currentcolor]/25" />
              </p>
              {timeGroup.folderGroups.map((group) => (
                <section key={group.label} aria-label={`${timeGroup.label} ${group.label} projects`} className="space-y-1">
                  <p className="m-0 mt-8 truncate px-2 font-mono text-[1.12rem] font-semibold leading-tight text-muted">
                    {group.label}
                  </p>
                  <div className="space-y-1 pl-2">
                    {group.projects.map((project) => renderProjectLink(project))}
                  </div>
                </section>
              ))}
            </section>
          ))}
          {!projects.length ? (
            <p className="m-0 text-[0.84rem] leading-6 text-muted">
              No projects were found.
            </p>
          ) : null}
        </nav>
      </section>
    </div>
  );
}

export default memo(forwardRef(ProjectPicker));
