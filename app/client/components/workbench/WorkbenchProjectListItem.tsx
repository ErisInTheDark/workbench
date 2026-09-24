/*
 * Exports:
 * - default WorkbenchProjectListItem: canonical project row with compact and listbox presentation.
 */
"use client";

import type { MouseEvent } from "react";
import { createLogicalProjectRoute, createProjectRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import type { DisplaySidebarProject, LogicalSidebarProject, ProjectSidebarProject } from "./project-sidebar-groups";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";
import { formatThreadRelativeTimestamp } from "./thread-view/thread-view-formatters";
import { getWorkbenchThreadStatusClassName } from "./workbench-thread-status-colors";
import WorkbenchTooltip from "./WorkbenchTooltip";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";

function getProjectActivityLabel(activityAt: number | null, nowMs: number) {
  return activityAt === null ? "" : formatThreadRelativeTimestamp(activityAt / 1000, nowMs);
}

function ProjectTooltipContent({ entry, nowMs }: { entry: DisplaySidebarProject; nowMs: number }) {
  const { project, summary } = entry;
  const logical = "matchKey" in project;
  const unsettledThreads = logical
    ? (summary as LogicalSidebarProject["summary"])?.unsettledThreads.map(item => ({
      entry: item.entry, source: item.location,
    })) ?? []
    : (summary as ProjectSidebarProject["summary"])?.unsettledThreads.map(item => ({
      entry: item, source: null,
    })) ?? [];
  return (
    <div className="flex max-h-full min-w-0 max-w-[min(30rem,calc(100vw-2rem))] flex-col gap-2">
      <div className="min-w-0">
        <p className="m-0 break-words text-[0.9rem] font-medium leading-[1.45] text-text">{logical ? project.label : project.name || project.id}</p>
        <p className="m-0 whitespace-pre-wrap break-all font-mono text-[0.72rem] leading-[1.45] text-fg/muted">
          {logical ? project.locations.map(location => `${location.hostname}: ${location.rootPath}`).join("\n")
            : WorkbenchProjectLabel.getFullPath(project)}
        </p>
      </div>
      <div className="scrollbar-hover-reveal flex max-h-64 min-h-0 flex-col gap-1 overflow-y-auto">
        {unsettledThreads.map(({ entry: thread, source }) => {
          const status = WorkbenchThreadStatusCounts.itemsByKey.get(thread.status) ?? WorkbenchThreadStatusCounts.items.at(-1)!;
          const threadTimestamp = new Date(thread.activityAt);
          return (
            <div className="flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[0.76rem]" key={`${source ? `${source.daemonId}:${source.projectId}:` : ""}${thread.identity.harness}:${thread.identity.threadId}`}>
              <span aria-label={status.label} className="inline-flex shrink-0" title={status.label}>
                <status.Icon className={`size-3.5 ${getWorkbenchThreadStatusClassName(status.tone)}`} />
              </span>
              <span className="min-w-0 flex-1 truncate text-text">{thread.title}</span>
              <time className="shrink-0 text-fg/muted" dateTime={threadTimestamp.toISOString()} title={threadTimestamp.toLocaleString()}>
                {formatThreadRelativeTimestamp(thread.activityAt / 1000, nowMs)}
              </time>
            </div>
          );
        })}
        {!unsettledThreads.length ? <p className="m-0 px-1.5 text-[0.76rem] text-fg/muted">No unsettled threads.</p> : null}
      </div>
    </div>
  );
}

export default function WorkbenchProjectListItem({
  active = false,
  compact: compactOverride,
  entry,
  id,
  nowMs,
  onProjectLinkClick,
  role,
  selected = false,
  showTooltip = true,
  tabIndex,
}: {
  active?: boolean;
  compact?: boolean;
  entry: DisplaySidebarProject;
  id?: string;
  nowMs: number;
  onProjectLinkClick(event: MouseEvent<HTMLAnchorElement>, projectId: string, logical?: boolean): void;
  role?: "option";
  selected?: boolean;
  showTooltip?: boolean;
  tabIndex?: number;
}) {
  const projectHref = useWorkbenchProjectNavigation();
  const { activityAt, project, summary } = entry;
  const counts = summary?.counts ?? WorkbenchThreadStatusCounts.emptyCounts;
  const dominantStatus = WorkbenchThreadStatusCounts.items.find(({ key }) => (counts[key] ?? 0) > 0) ?? null;
  const statusClassName = dominantStatus ? getWorkbenchThreadStatusClassName(dominantStatus.tone) : "text-fg/muted";
  const timestamp = activityAt === null ? null : new Date(activityAt);
  const logical = "matchKey" in project;
  const compact = compactOverride ?? (!logical && project.kind === "workbench-library" || !dominantStatus);
  const projectTitle = <WorkbenchProjectLabel active={active} project={project} />;
  const content = compact || !dominantStatus ? (
    <div className="pointer-events-none relative z-10 grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center py-1 pr-2 pl-2 md:min-h-0">
      {dominantStatus ? <dominantStatus.Icon className={`mr-1.5 size-3.5 ${statusClassName}`} /> : null}
      <span className={dominantStatus ? "col-start-2 min-w-0" : "col-span-2 col-start-1 min-w-0"}>{projectTitle}</span>
      <span className="col-start-3 row-start-1 ml-2 text-[0.72rem] text-fg/muted">
        {timestamp ? (
          <time dateTime={timestamp.toISOString()} title={timestamp.toLocaleString()}>
            {getProjectActivityLabel(activityAt, nowMs)}
          </time>
        ) : null}
      </span>
    </div>
  ) : (
    <div className="pointer-events-none relative z-10 min-w-0 pr-2">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] pt-1.5 pl-2">
        {projectTitle}
      </div>
      <div className="mt-0.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 pb-1.5 pl-2 text-[0.72rem] text-fg/muted">
        <dominantStatus.Icon className={`size-3.5 ${statusClassName}`} />
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`inline-flex min-w-0 items-center gap-1 ${statusClassName}`}>
            <span className="shrink-0 font-semibold">{counts[dominantStatus.key]}</span>
            <span className="truncate">
              {dominantStatus.key === "needsAttentionActive" ? "Needs attention" : dominantStatus.label}
            </span>
          </span>
          <WorkbenchThreadStatusCounts counts={counts} excludeKey={dominantStatus.key} />
        </span>
        {timestamp ? (
          <time dateTime={timestamp.toISOString()} title={timestamp.toLocaleString()}>
            {getProjectActivityLabel(activityAt, nowMs)}
          </time>
        ) : <span />}
      </div>
    </div>
  );
  return (
    <WorkbenchTooltip content={<ProjectTooltipContent entry={entry} nowMs={nowMs} />} enabled={showTooltip} interactive>
      <div
        className={`group/project-row relative isolate m-0 min-h-11 rounded-[0.8rem] ${compact ? "md:min-h-0" : ""}`}
        data-project-status-tone={dominantStatus?.tone ?? "none"}
      >
        <svg
          aria-hidden="true"
          className={`
            pointer-events-none absolute inset-0 z-0 size-full transition-opacity duration-75 ease-out
            ${statusClassName}
            ${active || selected ? "opacity-100" : "opacity-0 group-hover/project-row:opacity-100 group-has-[:focus-visible]/project-row:opacity-100"}
          `}
        >
          <rect
            fill="color-mix(in srgb, var(--text) 4%, transparent)"
            height="calc(100% - 1px)"
            rx="12.8"
            stroke="currentColor"
            strokeDasharray={dominantStatus?.dashed ? "6 4" : undefined}
            strokeOpacity={dominantStatus ? 1 : 0.24}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            width="calc(100% - 1px)"
            x="0.5"
            y="0.5"
          />
        </svg>
        {!active || role === "option" ? (
          <a
            aria-label={`Open ${logical ? project.label : project.name || project.id}`}
            aria-selected={role === "option" ? selected : undefined}
            className="absolute inset-0 z-20 cursor-pointer rounded-[0.8rem] border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            href={projectHref(logical ? createLogicalProjectRoute(project.id) : createProjectRoute(project.id))}
            id={id}
            onClick={(event) => onProjectLinkClick(event, project.id, logical)}
            role={role}
            tabIndex={tabIndex}
          />
        ) : null}
        {content}
      </div>
    </WorkbenchTooltip>
  );
}
