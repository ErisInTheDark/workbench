/*
 * Exports:
 * - default ProjectSidebar: render a flush project disclosure with thread-style cards, progressive activity groups, and live cross-project status summaries. Keywords: project, sidebar, disclosure, status, activity.
 * - Local components: render dominant-status project borders and detailed unsettled-thread tooltips from the shared summary store. Keywords: project, card, tooltip, browser.
 */
"use client";

import { useMemo, useState, useSyncExternalStore, type MouseEvent } from "react";

import type { WorkbenchProjectOption, WorkbenchThreadSidebarStore } from "../../lib/types";
import { createProjectHref } from "../../lib/workbench/navigation/workbench-route";
import ChevronIcon from "./ChevronIcon";
import { groupSidebarProjects, type ProjectSidebarProject } from "./project-sidebar-groups";
import WorkbenchProjectLabel from "./WorkbenchProjectLabel";
import { formatThreadRelativeTimestamp } from "./thread-view/thread-view-formatters";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import { workbenchIconButtonClassName, workbenchNewEntryButtonClassName } from "./workbench-class-names";
import { getWorkbenchThreadStatusClassName } from "./workbench-thread-status-colors";
import { ProjectStatusSummaryIcon } from "./workbench-icons";
import WorkbenchTooltip from "./WorkbenchTooltip";
import WorkbenchThreadStatusCounts from "./WorkbenchThreadStatusCounts";

const EMPTY_PROJECT_THREAD_SUMMARIES = { projects: [] };

function getProjectActivityLabel(activityAt: number | null, nowMs: number) {
  return activityAt === null ? "" : formatThreadRelativeTimestamp(activityAt / 1000, nowMs);
}

function ProjectTooltipContent({
  entry,
  nowMs,
}: {
  entry: ProjectSidebarProject;
  nowMs: number;
}) {
  const { project, summary } = entry;
  const unsettledThreads = summary?.unsettledThreads ?? [];
  return (
    <div className="flex max-h-full min-w-0 max-w-[min(30rem,calc(100vw-2rem))] flex-col gap-2">
      <div className="min-w-0">
        <p className="m-0 break-words text-[0.9rem] font-medium leading-[1.45] text-text">{project.name || project.id}</p>
        <p className="m-0 whitespace-pre-wrap break-all font-mono text-[0.72rem] leading-[1.45] text-muted">{WorkbenchProjectLabel.getFullPath(project)}</p>
      </div>
      <div className="explorer-scrollbar flex max-h-64 min-h-0 flex-col gap-1 overflow-y-auto">
        {unsettledThreads.map((thread) => {
          const status = WorkbenchThreadStatusCounts.itemsByKey.get(thread.status) ?? WorkbenchThreadStatusCounts.items.at(-1)!;
          const threadTimestamp = new Date(thread.activityAt);
          return (
            <div className="flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[0.76rem]" key={`${thread.identity.harness}:${thread.identity.threadId}`}>
              <span aria-label={status.label} className="inline-flex shrink-0" title={status.label}>
                <status.Icon className={`size-3.5 ${getWorkbenchThreadStatusClassName(status.tone)}`} />
              </span>
              <span className="min-w-0 flex-1 truncate text-text">{thread.title}</span>
              <time className="shrink-0 text-muted" dateTime={threadTimestamp.toISOString()} title={threadTimestamp.toLocaleString()}>
                {formatThreadRelativeTimestamp(thread.activityAt / 1000, nowMs)}
              </time>
            </div>
          );
        })}
        {!unsettledThreads.length ? <p className="m-0 px-1.5 text-[0.76rem] text-muted">No unsettled threads.</p> : null}
      </div>
    </div>
  );
}

function ProjectCard({
  active,
  entry,
  nowMs,
  onProjectLinkClick,
}: {
  active: boolean;
  entry: ProjectSidebarProject;
  nowMs: number;
  onProjectLinkClick(event: MouseEvent<HTMLAnchorElement>, projectId: string): void;
}) {
  const { activityAt, project, summary } = entry;
  const counts = summary?.counts ?? WorkbenchThreadStatusCounts.emptyCounts;
  const dominantStatus = WorkbenchThreadStatusCounts.items.find(({ key }) => counts[key] > 0) ?? null;
  const statusClassName = dominantStatus ? getWorkbenchThreadStatusClassName(dominantStatus.tone) : "text-muted";
  const timestamp = activityAt === null ? null : new Date(activityAt);
  const compact = project.kind === "workbench-library" || !dominantStatus;
  const projectTitle = <WorkbenchProjectLabel active={active} project={project} />;
  const content = compact ? (
    <div className="pointer-events-none relative z-10 grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center py-1 pr-2 pl-2 md:min-h-0">
      {dominantStatus ? <dominantStatus.Icon className={`mr-1.5 size-3.5 ${statusClassName}`} /> : null}
      <span className={dominantStatus ? "col-start-2 min-w-0" : "col-span-2 col-start-1 min-w-0"}>{projectTitle}</span>
      <span className="col-start-3 row-start-1 ml-2 text-[0.72rem] text-muted">
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
      <div className="mt-0.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 pb-1.5 pl-2 text-[0.72rem] text-muted">
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
    <WorkbenchTooltip content={<ProjectTooltipContent entry={entry} nowMs={nowMs} />} interactive>
      <div className={`group/project-row relative isolate m-0 min-h-11 rounded-[0.8rem]${compact ? " md:min-h-0" : ""}`} data-project-status-tone={dominantStatus?.tone ?? "none"}>
        <svg
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 z-0 size-full transition-opacity duration-75 ease-out ${statusClassName} ${active ? "opacity-100" : "opacity-0 group-hover/project-row:opacity-100 group-has-[:focus-visible]/project-row:opacity-100"}`}
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
        {!active ? (
          <a
            aria-label={`Open ${project.name || project.id}`}
            className="absolute inset-0 z-20 cursor-pointer rounded-[0.8rem] border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            href={createProjectHref(project.id)}
            onClick={(event) => onProjectLinkClick(event, project.id)}
          />
        ) : null}
        {content}
      </div>
    </WorkbenchTooltip>
  );
}

export default function ProjectSidebar({
  activeProjectId,
  onProjectLinkClick,
  projects,
  store,
}: {
  activeProjectId: string;
  onProjectLinkClick(event: MouseEvent<HTMLAnchorElement>, projectId: string): void;
  projects: readonly WorkbenchProjectOption[];
  store: WorkbenchThreadSidebarStore | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [showOtherSummary, setShowOtherSummary] = useState(true);
  const [visibleTimeGroupCount, setVisibleTimeGroupCount] = useState(1);
  const summaries = useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.getProjectThreadSummaries ?? (() => EMPTY_PROJECT_THREAD_SUMMARIES),
    () => EMPTY_PROJECT_THREAD_SUMMARIES,
  );
  const grouped = useMemo(() => groupSidebarProjects(projects, summaries.projects), [projects, summaries.projects]);
  const entriesByProjectId = useMemo(() => new Map(
    [...grouped.alwaysVisibleProjects, ...grouped.timeGroups.flatMap(({ projects: entries }) => entries)]
      .map((entry) => [entry.project.id, entry]),
  ), [grouped]);
  const activeEntry = entriesByProjectId.get(activeProjectId) ?? null;
  const otherCounts = useMemo(() => projects.reduce(
    (counts, project) => {
      if (project.id === activeProjectId) return counts;
      const summary = entriesByProjectId.get(project.id)?.summary;
      const unpinnedCounts = summary
        ? WorkbenchThreadStatusCounts.subtractCounts(
          summary.counts,
          WorkbenchThreadStatusCounts.countPinnedStatuses(summary.pinnedThreads),
        )
        : WorkbenchThreadStatusCounts.emptyCounts;
      return WorkbenchThreadStatusCounts.addCounts(counts, unpinnedCounts);
    },
    WorkbenchThreadStatusCounts.emptyCounts,
  ), [activeProjectId, entriesByProjectId, projects]);
  const visibleProjects = [
    ...grouped.alwaysVisibleProjects,
    ...grouped.timeGroups.slice(0, visibleTimeGroupCount).flatMap(({ projects: entries }) => entries),
  ];
  const hasMoreTimeGroups = visibleTimeGroupCount < grouped.timeGroups.length;
  const nowMs = Date.now();

  const summary = (
    <div className="space-y-1.5">
      <div className="group/entry-row flex min-w-0 items-center justify-between gap-2 py-1.5">
        <span className="flex min-w-0 items-center gap-2 text-base font-semibold leading-tight text-text">
          <ChevronIcon className="size-[1.1rem] transition-transform" data-thread-chevron />
          <span>Projects</span>
        </span>
        <button
          aria-label={showOtherSummary ? "Hide other project status summary" : "Show other project status summary"}
          aria-pressed={showOtherSummary}
          className={`${workbenchIconButtonClassName} ${workbenchNewEntryButtonClassName}${showOtherSummary ? " bg-accent-soft text-accent" : ""}${isOpen ? " invisible pointer-events-none" : ""}`}
          data-thread-summary-action="true"
          onClick={() => setShowOtherSummary((current) => !current)}
          tabIndex={isOpen ? -1 : undefined}
          title={showOtherSummary ? "Hide other project status summary" : "Show other project status summary"}
          type="button"
        >
          <ProjectStatusSummaryIcon className="size-4" />
        </button>
      </div>
      {!isOpen && activeEntry ? (
        <ProjectCard active entry={activeEntry} nowMs={nowMs} onProjectLinkClick={onProjectLinkClick} />
      ) : null}
      {!isOpen && showOtherSummary && WorkbenchThreadStatusCounts.hasCounts(otherCounts) ? (
        <div className="flex min-w-0 items-center justify-between gap-2 px-2 py-1 text-[0.72rem] text-muted">
          <span className="truncate">Other projects</span>
          <WorkbenchThreadStatusCounts counts={otherCounts} />
        </div>
      ) : null}
    </div>
  );

  return (
    <section className="shrink-0 pb-6 md:pr-2.5">
      <ThreadDisclosure
        chevronClassName="hidden"
        contentClassName="pb-3"
        onToggle={(event) => {
          const nextOpen = event.currentTarget.open;
          setIsOpen(nextOpen);
          if (!nextOpen) setVisibleTimeGroupCount(1);
        }}
        open={isOpen}
        summary={summary}
        summaryClassName="min-h-11 items-start text-muted md:min-h-0"
      >
        <nav aria-label="Projects" className="flex flex-col gap-1">
          {visibleProjects.map((entry) => (
            <ProjectCard
              active={entry.project.id === activeProjectId}
              entry={entry}
              key={entry.project.id}
              nowMs={nowMs}
              onProjectLinkClick={onProjectLinkClick}
            />
          ))}
          {hasMoreTimeGroups ? (
            <button
              className="w-full rounded-lg px-2 py-1.5 text-left text-[0.78rem] font-medium text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none"
              onClick={() => setVisibleTimeGroupCount((current) => current + 1)}
              type="button"
            >
              Show {grouped.timeGroups[visibleTimeGroupCount]?.label ?? "older projects"}
            </button>
          ) : null}
          {!projects.length ? <p className="m-0 px-2 text-[0.8rem] leading-5 text-muted">No projects were found.</p> : null}
        </nav>
      </ThreadDisclosure>
    </section>
  );
}
