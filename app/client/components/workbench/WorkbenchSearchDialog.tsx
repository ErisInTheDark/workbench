/*
 * Exports:
 * - default WorkbenchSearchDialog: full-screen accessible search dialog and keyboard-driven result list.
 */
"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import type { WorkbenchProjectThreadSidebars, WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchSearchController from "../../workbench/search/WorkbenchSearchController";
import WorkbenchProjectListItem from "./WorkbenchProjectListItem";
import WorkbenchThreadListItem from "./WorkbenchThreadListItem";
import WorkbenchSearchResultItem from "./WorkbenchSearchResultItem";

export default function WorkbenchSearchDialog({ controller, projects, projectSidebars, projectSummaries }: {
  controller: WorkbenchSearchController;
  projects: readonly WorkbenchProjectOption[];
  projectSidebars: WorkbenchProjectThreadSidebars;
  projectSummaries: WorkbenchProjectThreadSummaries;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const projectHref = useWorkbenchProjectNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!snapshot.isOpen) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => restoreFocusRef.current?.focus();
  }, [snapshot.isOpen]);

  useEffect(() => {
    document.getElementById(`workbench-search-result-${snapshot.selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [snapshot.selectedIndex]);

  if (!snapshot.isOpen) return null;
  return (
    <div
      aria-label="Workspace search"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-background/70 px-3 pb-8 pt-[8vh] backdrop-blur-md md:px-8 md:pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) controller.close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          controller.close();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input, button:not([disabled]), a[href]"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      role="dialog"
    >
      <div className="flex max-h-[78vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-background/90 shadow-2xl ring-1 ring-text/10">
        <input
          aria-activedescendant={snapshot.results.length ? `workbench-search-result-${snapshot.selectedIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls="workbench-search-results"
          aria-expanded="true"
          className="h-20 w-full shrink-0 bg-transparent px-6 text-2xl text-text outline-none placeholder:text-fg/muted md:h-24 md:px-8 md:text-3xl"
          onChange={(event) => controller.setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); controller.moveSelection(1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); controller.moveSelection(-1); }
            else if (event.key === "Enter") { event.preventDefault(); controller.activateSelected(); }
            else if (event.key === "Escape") { event.preventDefault(); controller.close(); }
          }}
          placeholder="Search"
          ref={inputRef}
          role="combobox"
          type="search"
          value={snapshot.query}
        />
        <div aria-live="polite" className="sr-only">
          {snapshot.isLoading ? "Searching" : `${snapshot.results.length} results`}
        </div>
        <div className="h-px shrink-0 bg-gradient-to-r from-transparent via-text/15 to-transparent" />
        <div
          className="explorer-scrollbar flex min-h-24 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2 text-[0.9rem] leading-6 md:px-4"
          id="workbench-search-results"
          role="listbox"
        >
          {snapshot.error ? <p className="px-4 py-5 text-sm text-red-500">{snapshot.error}</p> : null}
          {snapshot.isLoading ? <p className="px-2 py-2 text-sm text-fg/muted">Searching...</p> : null}
          {!snapshot.error && !snapshot.isLoading && snapshot.results.length === 0 ? (
            <p className="px-4 py-5 text-sm text-fg/muted">No matching results.</p>
          ) : null}
          {snapshot.results.map((result, index) => {
            const id = `workbench-search-result-${index}`;
            const selected = index === snapshot.selectedIndex;
            const project = result.kind === "action" ? undefined : projects.find(({ id }) => id === result.projectId);
            const summary = projectSummaries.projects.find(({ projectId }) => projectId === project?.id) ?? null;
            const thread = result.kind === "thread"
              ? projectSidebars.projects.find(({ projectId }) => projectId === result.projectId)?.entries.find((entry) => (
                entry.entryKind !== "draft" && entry.identity.harness === result.harnessId && entry.identity.threadId === result.threadId
              ))
              : undefined;
            return (
              <div
                className="shrink-0"
                key={result.id}
                onMouseMove={() => {
                  const delta = index - controller.getSnapshot().selectedIndex;
                  if (delta) controller.moveSelection(delta);
                }}
                role="presentation"
              >
                {result.kind === "project" && project ? (
                  <WorkbenchProjectListItem
                    compact
                    entry={{ activityAt: summary?.lastThreadUpdateAt ?? project.lastCommitTimeMs, project, summary }}
                    id={id}
                    nowMs={Date.now()}
                    onProjectLinkClick={(event) => { event.preventDefault(); controller.activate(result); }}
                    role="option"
                    selected={selected}
                    showTooltip={false}
                  />
                ) : result.kind === "thread" && thread && thread.entryKind !== "draft" ? (
                  <WorkbenchThreadListItem
                    compact
                    dimmedOverride={false}
                    entry={thread}
                    href={projectHref(createThreadRoute(result.projectId, { kind: "provider", harness: thread.identity.harness, threadId: thread.identity.threadId }))}
                    id={id}
                    onActivate={() => controller.activate(result)}
                    project={project}
                    projectId={ProjectIdSchema.parse(result.projectId)}
                    role="option"
                    secondaryRow={(
                      <span className="flex min-w-0 gap-2 pl-5 text-[0.72rem] leading-4 text-fg/muted">
                        <span className="max-w-40 shrink-0 truncate">{project?.name || result.projectId}</span>
                        {result.detail !== result.projectId ? <span className="min-w-0 truncate" title={result.detail}>{result.detail}</span> : null}
                      </span>
                    )}
                    selected={selected}
                    showTooltip={false}
                  />
                ) : (
                  <WorkbenchSearchResultItem id={id} onActivate={() => controller.activate(result)} result={result} selected={selected} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
