/*
 * Exports:
 * - default WorkbenchSearchDialog: full-screen accessible search dialog with kind and scope filters, kind sections,
 *   painted matches, a steady result list that dims while the next query runs, and keyboard hints.
 * - findSearchThreadEntry: resolve a thread hit to its summary row when the summary lives at the hit's source.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkbenchSearchKind } from "workbench-shared/workbench/search/workbench-search";

import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import type { WorkspaceThreadSummary } from "workbench-shared/workbench/workspace/workspace-observation";
import { WORKBENCH_SEARCH_FILTERS, WorkbenchSearchHit } from "../../../workbench/search/WorkbenchSearchController";
import { useWorkbenchExplorer } from "../explorer/workbench-explorer-context";
import { useProjects } from "../use-projects";
import Keybind from "../../ui/Keybind";
import RadioRow from "../../ui/RadioRow";
import { statsReloadingClassName } from "../../ui/Skeleton";
import WorkbenchProjectLabel from "../WorkbenchProjectLabel";
import WorkbenchProjectListItem from "../WorkbenchProjectListItem";
import WorkbenchThreadListItem from "../WorkbenchThreadListItem";
import { useWorkbenchSearch } from "./workbench-search-context";
import WorkbenchSearchResultItem, {
  WorkbenchSearchExcerpt, searchFilterLabel, searchSectionLabel,
} from "./WorkbenchSearchResultItem";
import useSearchHighlight from "../../../workbench/search/use-search-highlight";

/** A thread hit's row, from its summary, only when the summary lives at the hit's own source. */
export function findSearchThreadEntry(readSummary: (threadId: string) => WorkspaceThreadSummary | null, result: WorkbenchSearchHit) {
  if (result.kind !== "thread" || !result.source) return undefined;
  const located = readSummary(result.threadId);
  if (!located || located.location.daemonId !== result.source.daemonId || located.location.projectId !== result.projectId) return undefined;
  return located.summary.row.identity.harness === result.harnessId ? located.summary.row : undefined;
}

/** Results arrive already grouped by kind; each run of one kind becomes a section. */
function groupSearchSections(results: readonly WorkbenchSearchHit[]) {
  const sections: Array<{ kind: WorkbenchSearchKind; results: WorkbenchSearchHit[]; start: number }> = [];
  results.forEach((result, index) => {
    const last = sections.at(-1);
    if (last?.kind === result.kind) last.results.push(result);
    else sections.push({ kind: result.kind, results: [result], start: index });
  });
  return sections;
}

/** Files and settings belong to a project, so their filters only appear with one in view. */
const PROJECT_KINDS: ReadonlySet<WorkbenchSearchKind> = new Set(["file", "projectSetting"]);

const ALL_KINDS = "all";
type KindOption = WorkbenchSearchKind | typeof ALL_KINDS;

export default function WorkbenchSearchDialog() {
  const { projects } = useWorkbenchExplorer();
  const controller = useWorkbenchSearch();
  const snapshot = useWorkbenchSearch.snapshot();
  const logicalProjects = useProjects();
  const logicalSummaries = useProjects.summaries();
  const projectSummaries = useProjects.threads();
  const projectHref = useWorkbenchProjectNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [resultList, setResultList] = useState<HTMLElement | null>(null);
  const corrected = snapshot.corrections.map(correction => correction.to);
  useSearchHighlight(resultList, [snapshot.query, ...corrected].join(" "));

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
  const scopeProject = snapshot.projectId ? logicalProjects?.find(item => item.id === snapshot.projectId) : undefined;
  const scopeName = snapshot.projectId
    ? (scopeProject ? scopeProject.displayName ?? scopeProject.label : null)
      ?? projects.find(item => item.id === snapshot.projectId)?.name ?? null
    : null;
  const filters = WORKBENCH_SEARCH_FILTERS.filter(kind => !kind || !PROJECT_KINDS.has(kind) || snapshot.projectId);
  const sections = groupSearchSections(snapshot.results);
  const renderResult = (result: WorkbenchSearchHit, index: number) => {
    const id = `workbench-search-result-${index}`;
    const selected = !snapshot.stale && index === snapshot.selectedIndex;
    const project = result.kind === "action" ? undefined : projects.find(({ id }) => id === result.projectId);
    const logicalProject = result.logicalProjectId
      ? logicalProjects?.find(item => item.id === result.logicalProjectId) : undefined;
    const summary = projectSummaries.projects.find(({ projectId }) => projectId === project?.id) ?? null;
    const thread = findSearchThreadEntry(controller.readSummary, result);
    return (
      <div
        className="min-w-0 shrink-0"
        key={result.id}
        onMouseMove={() => {
          const delta = index - controller.getSnapshot().selectedIndex;
          if (delta && !controller.getSnapshot().stale) controller.moveSelection(delta);
        }}
        role="presentation"
      >
        {result.kind === "project" && (logicalProject || project) ? (
          <WorkbenchProjectListItem
            entry={logicalProject ? {
              activityAt: logicalSummaries?.[logicalProject.id]?.lastThreadUpdateAt ?? null,
              project: logicalProject, summary: logicalSummaries?.[logicalProject.id] ?? null,
            } : {
              activityAt: summary?.lastThreadUpdateAt ?? project!.lastCommitTimeMs, project: project!, summary,
            }}
            id={id}
            onProjectLinkClick={(event) => { event.preventDefault(); controller.activate(result); }}
            role="option"
            selected={selected}
            showTooltip={false}
          />
        ) : result.kind === "thread" && thread ? (
          <WorkbenchThreadListItem
            compact={false}
            dimmedOverride={false}
            entry={thread}
            href={projectHref(WorkbenchSearchHit.threadRoute(result) ?? createThreadRoute(result.projectId,
              { kind: "provider", harness: thread.identity.harness, threadId: thread.identity.threadId }))}
            id={id}
            onActivate={() => controller.activate(result)}
            project={logicalProject ?? project}
            projectId={ProjectIdSchema.parse(result.projectId)}
            role="option"
            secondaryRow={result.excerpt || result.detail ? <WorkbenchSearchExcerpt result={result} /> : undefined}
            selected={selected}
            showTooltip={false}
          />
        ) : (
          <WorkbenchSearchResultItem
            eyebrow={result.kind === "thread" && (logicalProject ?? project)
              ? <WorkbenchProjectLabel project={(logicalProject ?? project)!} source={result.source} variant="thread" /> : undefined}
            id={id}
            onActivate={() => controller.activate(result)}
            result={result}
            selected={selected}
          />
        )}
      </div>
    );
  };
  return (
    <div
      aria-label="Workspace search"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-background/70 px-3 pb-8 pt-[8vh] backdrop-blur-md md:px-8 md:pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) controller.close();
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          controller.close();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input, button:not([disabled]):not([tabindex='-1']), a[href]"));
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
      <div className="flex max-h-[78vh] w-full max-w-4xl min-w-0 flex-col overflow-hidden rounded-3xl bg-background/90 shadow-2xl ring-1 ring-text/10">
        <div className="flex shrink-0 items-center gap-3 pr-6 md:pr-8">
        <input
          aria-activedescendant={snapshot.results.length && !snapshot.stale ? `workbench-search-result-${snapshot.selectedIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls="workbench-search-results"
          aria-expanded="true"
          className="
            h-18 min-w-0 flex-1 bg-transparent pl-6 text-2xl text-text outline-none placeholder:text-fg/muted md:h-20 md:pl-8 md:text-3xl
            [&::-webkit-search-cancel-button]:appearance-none
          "
          onChange={(event) => controller.setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); controller.moveSelection(1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); controller.moveSelection(-1); }
            else if (event.key === "Enter") { event.preventDefault(); controller.activateSelected(); }
            else if (event.key === "Escape") { event.preventDefault(); controller.close(); }
            else if (event.key === "Tab") { event.preventDefault(); controller.cycleKind(event.shiftKey ? -1 : 1); }
          }}
          placeholder={snapshot.kind ? `Search ${searchFilterLabel(snapshot.kind).toLowerCase()}` : "Search threads, files, projects and actions"}
          ref={inputRef}
          role="combobox"
          type="search"
          value={snapshot.query}
        />
        {snapshot.isLoading ? <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" /> : null}
        </div>
        {/* Picking a filter hands focus straight back to the query, so typing never lands on a radio. */}
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 md:px-6">
          <RadioRow<KindOption>
            ariaLabel="Search kinds"
            onChange={kind => { controller.setKind(kind === ALL_KINDS ? null : kind); inputRef.current?.focus(); }}
            options={filters.map(kind => ({ label: searchFilterLabel(kind), value: kind ?? ALL_KINDS }))}
            value={snapshot.kind ?? ALL_KINDS}
          />
          {scopeName && (!snapshot.kind || snapshot.kind === "thread") ? (
            <RadioRow<"project" | "all">
              ariaLabel="Thread scope"
              onChange={scope => { controller.setProjectOnly(scope === "project"); inputRef.current?.focus(); }}
              options={[
                { label: `In ${scopeName}`, title: `Threads in ${scopeName}`, value: "project" },
                { label: "All projects", title: "Threads in every project", value: "all" },
              ]}
              value={snapshot.projectOnly ? "project" : "all"}
            />
          ) : null}
        </div>
        <div className="h-px shrink-0 bg-gradient-to-r from-transparent via-fg/15 to-transparent" />
        <div aria-live="polite" className="sr-only">
          {snapshot.isLoading ? "Searching" : `${snapshot.results.length} results`}
        </div>
        <div
          aria-busy={snapshot.isLoading || snapshot.stale}
          className={`
            scrollbar-hover-reveal flex min-h-24 min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2 text-[0.9rem] leading-6 md:px-4
            ${statsReloadingClassName(snapshot.stale)}
          `}
          id="workbench-search-results"
          ref={setResultList}
          role="listbox"
        >
          {snapshot.error ? <p className="px-4 py-5 text-sm text-red-500">{snapshot.error}</p> : null}
          {corrected.length && snapshot.results.length && !snapshot.stale ? (
            <p className="px-2 pt-2 text-[0.8rem] text-fg/muted">
              Showing results for <span className="font-semibold text-text">{corrected.join(", ")}</span>
            </p>
          ) : null}
          {!snapshot.error && !snapshot.isLoading && !snapshot.stale && snapshot.results.length === 0 ? (
            <p className="px-4 py-5 text-sm text-fg/muted">
              {snapshot.query.trim() ? `No ${snapshot.kind ? searchFilterLabel(snapshot.kind).toLowerCase() : "results"} match "${snapshot.query.trim()}".`
                : snapshot.kind ? `Type to search ${searchFilterLabel(snapshot.kind).toLowerCase()}.` : "Nothing here yet."}
            </p>
          ) : null}
          {sections.map(({ kind, results, start }) => (
            <div aria-labelledby={`workbench-search-section-${kind}`} className="flex min-w-0 shrink-0 flex-col gap-0.5" key={kind} role="group">
              {sections.length > 1 || !snapshot.kind ? (
                <div
                  className="sticky top-0 z-30 -mx-2 bg-background/95 px-4 pb-1 pt-3 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-fg/muted backdrop-blur-sm md:-mx-4 md:px-6"
                  id={`workbench-search-section-${kind}`}
                  role="presentation"
                >
                  {searchSectionLabel(kind)}
                </div>
              ) : <span className="sr-only" id={`workbench-search-section-${kind}`}>{searchSectionLabel(kind)}</span>}
              {results.map((result, offset) => renderResult(result, start + offset))}
            </div>
          ))}
        </div>
        <div className="hidden shrink-0 items-center gap-3 border-t border-fg/8 px-6 py-2 text-[0.72rem] text-fg/muted md:flex">
          <span className="flex items-center gap-1"><Keybind keys={["↑"]} /><Keybind keys={["↓"]} /> select</span>
          <span className="flex items-center gap-1"><Keybind keys={["↵"]} /> open</span>
          <span className="flex items-center gap-1"><Keybind keys={["Tab"]} /> filter</span>
          <span className="ml-auto flex items-center gap-1"><Keybind keys={["\"exact phrase\""]} /> <Keybind keys={["-exclude"]} /></span>
        </div>
      </div>
    </div>
  );
}
