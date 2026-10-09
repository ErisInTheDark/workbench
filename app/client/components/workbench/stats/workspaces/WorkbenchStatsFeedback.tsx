"use client";

/*
 * Exports:
 * - default WorkbenchStatsFeedback: agent friction reports for the selected projects, filterable by category tags, ordered by importance or recency, and selectable for deletion or addressing in a new thread.
 */
import { useContext, useEffect, useMemo, useState } from "react";
import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import { matchesWorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import {
  WORKBENCH_FEEDBACK_CATEGORIES,
  type WorkbenchFeedbackCategory,
  type WorkbenchFeedbackSort,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import WorkbenchRelativeTime from "../../WorkbenchRelativeTime";
import { useWorkbenchThreads } from "../../use-workbench-client";
import WorkbenchModeRow from "../../WorkbenchModeRow";
import { WorkbenchOperationsContext as WorkbenchDaemonClientContext } from "../../WorkbenchWorkspaceContext";
import useStats from "../use-stats";
import WorkbenchStatsSkeleton, { statsReloadingClassName, statsRevealClassName } from "../WorkbenchStatsSkeleton";
import WorkbenchStatsFeedbackReport from "./WorkbenchStatsFeedbackReport";
import WorkbenchStatsFeedbackSelectionBar from "./WorkbenchStatsFeedbackSelectionBar";
import {
  FEEDBACK_CATEGORY_PRESENTATION,
  feedbackAddressProjectId,
  formatFeedbackForAgent,
  countFeedbackCategories,
  selectFeedbackItems,
} from "./stats-feedback-presentation";

/** Model catalogues for the harnesses that authored reports, read once each from the shared account cache. */
function useModelCatalogues(harnesses: readonly WorkbenchHarness[]) {
  const { listModels } = useWorkbenchThreads();
  const [catalogues, setCatalogues] = useState<ReadonlyMap<string, readonly WorkbenchModelOption[]>>(new Map());
  const key = [...new Set(harnesses)].sort().join("\0");
  useEffect(() => {
    let active = true;
    for (const harness of key ? key.split("\0") as WorkbenchHarness[] : []) {
      listModels(harness).then((models) => {
        if (active) setCatalogues((current) => new Map(current).set(harness, models));
      }).catch((error: unknown) => {
        console.warn("Feedback model names are unavailable.", {
          harness, reason: (error instanceof Error ? error.message : "Model read failed").slice(0, 300),
        });
      });
    }
    return () => { active = false; };
  }, [key, listModels]);
  return catalogues;
}

export default function WorkbenchStatsFeedback() {
  const { addressFeedback: onAddress, projectName } = useStats();
  const { data: stats, loading } = useStats.feedback();
  const daemon = useContext(WorkbenchDaemonClientContext);
  const [sort, setSort] = useState<WorkbenchFeedbackSort>("importance");
  const [categories, setCategories] = useState<ReadonlySet<WorkbenchFeedbackCategory>>(new Set());
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const feedback = stats?.feedback ?? null;
  const items = feedback?.items ?? [];
  // Selection follows the published reports, so deleted or out-of-period reports simply stop counting.
  const selected = items.filter(({ id }) => selectedIds.has(id));
  const addressProjectId = feedbackAddressProjectId(selected, feedback?.workbenchProjectId ?? null);
  const toggleSelected = (id: number) => setSelectedIds((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  useEffect(() => {
    if (!selected.length) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setSelectedIds(new Set());
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selected.length]);
  const deleteSelected = async () => {
    if (!daemon || !selected.length) return;
    setBusy(true);
    setActionError("");
    try {
      await daemon.stats.deleteFeedback(selected.map(({ id }) => id));
      setSelectedIds(new Set());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to delete the selected feedback.");
    } finally {
      setBusy(false);
    }
  };
  const visible = useMemo(() => selectFeedbackItems(items, categories, sort), [categories, items, sort]);
  const catalogues = useModelCatalogues(items.flatMap(({ harness }) => harness ? [harness] : []));
  const newest = items.reduce((latest, item) => Math.max(latest, item.createdAt), 0);
  const toggle = (category: WorkbenchFeedbackCategory) => setCategories((current) => {
    const next = new Set(current);
    if (!next.delete(category)) next.add(category);
    return next;
  });
  const modelName = (harness: string | null, model: string | null) => {
    if (!model) return null;
    const known = harness ? catalogues.get(harness)?.find((option) => matchesWorkbenchModelOption(option, model)) : undefined;
    return known?.displayName ?? model.slice(model.indexOf("/") + 1);
  };
  const origin = (channel: string, projectId: string) => channel === "project"
    ? projectName(projectId)
    : projectId === feedback?.workbenchProjectId ? "Workbench" : `Workbench, from ${projectName(projectId)}`;
  const address = () => {
    if (!addressProjectId) return;
    onAddress(addressProjectId, formatFeedbackForAgent(selected, {
      modelName: (item) => modelName(item.harness, item.model),
      origin: (item) => origin(item.channel, item.projectId),
    }));
    setSelectedIds(new Set());
  };
  return (
    <section aria-busy={loading} aria-labelledby="feedback-heading" className={`space-y-3 [--hue-chroma:60%] ${statsReloadingClassName(loading && Boolean(stats))}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="feedback-heading">Agent feedback</h2>
        {feedback?.total ? (
          <span className={`text-[0.72rem] text-fg/muted ${statsRevealClassName}`}>
            {feedback.total} {feedback.total === 1 ? "report" : "reports"}
            {newest ? <> · newest <WorkbenchRelativeTime timestampMs={newest} /></> : null}
          </span>
        ) : null}
      </div>
      {!feedback ? (
        // Category tags, then a few report cards.
        <div aria-hidden="true" className="space-y-3">
          <div className="flex gap-1">{[0, 1, 2, 3].map((index) => <WorkbenchStatsSkeleton className="h-6 w-20 rounded-full" key={index} />)}</div>
          {[0, 1, 2].map((index) => (
            <div className="space-y-2 py-2" key={index}>
              <WorkbenchStatsSkeleton className="h-3 w-40" />
              <WorkbenchStatsSkeleton className="h-3" style={{ width: `${88 - index * 14}%` }} />
              <WorkbenchStatsSkeleton className="h-3" style={{ width: `${62 - index * 10}%` }} />
            </div>
          ))}
        </div>
      ) : !feedback.total ? (
        <p className={`m-0 py-1 text-[0.8rem] text-fg/muted ${statsRevealClassName}`}>No agent feedback in this period.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div aria-label="Feedback categories" className="flex flex-wrap gap-1" role="group">
              {WORKBENCH_FEEDBACK_CATEGORIES.map((category) => {
                const count = feedback.counts.find((row) => row.category === category)?.count ?? 0;
                const on = categories.has(category);
                const { label, tagClassName } = FEEDBACK_CATEGORY_PRESENTATION[category];
                return (
                  <button
                    aria-pressed={on}
                    className={`
                      inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.74rem] font-semibold transition
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
                      disabled:cursor-default
                      ${!count ? "text-fg/35" : on || !categories.size ? tagClassName : "text-fg/muted hover:bg-fg/7"}
                      ${on ? "ring-1 ring-inset ring-current" : ""}
                    `}
                    disabled={!count}
                    key={category}
                    onClick={() => toggle(category)}
                    title={count ? `${on ? "Stop showing only" : "Show only"} ${label.toLowerCase()} reports` : `No ${label.toLowerCase()} reports`}
                    type="button"
                  >
                    {label}
                    <span className="font-normal tabular-nums opacity-80">{count}</span>
                  </button>
                );
              })}
            </div>
            <div className="ml-auto">
              <WorkbenchModeRow
                ariaLabel="Feedback order"
                onChange={setSort}
                options={[
                  { label: "Most important", title: "Strongest authors first", value: "importance" },
                  { label: "Newest", title: "Latest reports first", value: "newest" },
                ]}
                value={sort}
              />
            </div>
          </div>
          <ol aria-label="Agent feedback reports" aria-multiselectable className={`-mx-3 my-0 grid gap-y-1 p-0 ${statsRevealClassName}`} role="listbox">
            {visible.map((item) => (
              <WorkbenchStatsFeedbackReport
                item={item}
                key={item.id}
                modelName={modelName(item.harness, item.model)}
                onToggle={() => toggleSelected(item.id)}
                origin={origin(item.channel, item.projectId)}
                selected={selectedIds.has(item.id)}
              />
            ))}
          </ol>
          {feedback.total > items.length ? (
            <p className="m-0 text-[0.72rem] text-fg/muted">
              Showing the {items.length} most important of {feedback.total} reports. Narrow the period to see the rest.
            </p>
          ) : null}
        </>
      )}
      <WorkbenchStatsFeedbackSelectionBar
        addressBlocked={addressProjectId ? null : "The selected feedback belongs to more than one project; address one project at a time."}
        busy={busy}
        error={actionError}
        onAddress={address}
        onDelete={() => void deleteSelected()}
        selection={selected.length ? { counts: countFeedbackCategories(selected), total: selected.length } : null}
      />
    </section>
  );
}
