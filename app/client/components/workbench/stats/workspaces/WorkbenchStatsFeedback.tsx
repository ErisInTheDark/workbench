"use client";

/*
 * Exports:
 * - default WorkbenchStatsFeedback: agent friction reports for the selected projects, filterable by category tags, ordered by importance or recency, and selectable for deletion or addressing in a new thread.
 */
import { useContext, useEffect, useMemo, useState } from "react";
import {
  WORKBENCH_FEEDBACK_CATEGORIES,
  type WorkbenchFeedbackCategory,
  type WorkbenchFeedbackSort,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import WorkbenchRelativeTime from "../../WorkbenchRelativeTime";
import RadioRow from "../../../ui/RadioRow";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchWorkspaceContext from "../../WorkbenchWorkspaceContext";
import useStats from "../use-stats";
import Skeleton, { statsReloadingClassName, statsRevealClassName } from "../../../ui/Skeleton";
import WorkbenchStatsFeedbackReport, { WorkbenchFeedbackReportSkeleton } from "./WorkbenchStatsFeedbackReport";
import WorkbenchStatsFeedbackSelectionBar from "./WorkbenchStatsFeedbackSelectionBar";
import {
  FEEDBACK_CATEGORY_PRESENTATION,
  feedbackAddressProjectId,
  feedbackReference,
  countFeedbackCategories,
  selectFeedbackItems,
} from "./stats-feedback-presentation";

export default function WorkbenchStatsFeedback() {
  const { addressFeedback: onAddress, localProject, projectName, scope } = useStats();
  const { data: stats, loading } = useStats.feedback();
  const workspace = useContext(WorkbenchWorkspaceContext);
  const [sort, setSort] = useState<WorkbenchFeedbackSort>("importance");
  const [categories, setCategories] = useState<ReadonlySet<WorkbenchFeedbackCategory>>(new Set());
  // Report ids are only unique per daemon, so selection keys carry the daemon.
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const feedback = stats?.feedback ?? null;
  const items = feedback?.items ?? [];
  const keyOf = (item: { daemonId?: string | null; id: number }) => `${item.daemonId ?? ""}:${item.id}`;
  // Selection follows the published reports, so deleted or out-of-period reports simply stop counting.
  const selected = items.filter((item) => selectedKeys.has(keyOf(item)));
  // A new thread runs on this machine, so reports from elsewhere address this machine's folder of their project.
  const local = selected.map((item) => ({ ...item, projectId: localProject(item.projectId, item.daemonId) }));
  const addressProjectId = local.every((item) => item.projectId)
    ? feedbackAddressProjectId(local.map((item) => ({ ...item, projectId: item.projectId! })), feedback?.workbenchProjectId ?? null)
    : null;
  const toggleSelected = (key: string) => setSelectedKeys((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  useEffect(() => {
    if (!selected.length) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setSelectedKeys(new Set());
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selected.length]);
  const deleteSelected = async () => {
    if (!workspace || !selected.length) return;
    setBusy(true);
    setActionError("");
    try {
      // Each daemon deletes its own reports.
      const byDaemon = Map.groupBy(selected, ({ daemonId }) => daemonId ?? scope.attachedDaemonId);
      await Promise.all([...byDaemon].map(([daemonId, reports]) => {
        const daemon = DaemonIdSchema.safeParse(daemonId).data;
        if (!daemon) throw new Error("Feedback from an unknown machine cannot be deleted.");
        return workspace.daemon({ kind: "installation", daemonId: daemon }).stats.deleteFeedback(reports.map(({ id }) => id));
      }));
      setSelectedKeys(new Set());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to delete the selected feedback.");
    } finally {
      setBusy(false);
    }
  };
  const visible = useMemo(() => selectFeedbackItems(items, categories, sort), [categories, items, sort]);
  const modelName = useStats.modelNames(items.flatMap(({ harness }) => harness ? [harness] : []));
  const newest = items.reduce((latest, item) => Math.max(latest, item.createdAt), 0);
  const toggle = (category: WorkbenchFeedbackCategory) => setCategories((current) => {
    const next = new Set(current);
    if (!next.delete(category)) next.add(category);
    return next;
  });
  const address = () => {
    const attached = scope.attachedDaemonId;
    if (!addressProjectId || (!attached && selected.some((item) => !item.daemonId))) return;
    onAddress(addressProjectId, selected.map((item) => feedbackReference(item, {
      daemonId: item.daemonId ?? attached!,
      modelName: modelName(item.harness, item.model),
      projectName: projectName(item.projectId, item.daemonId),
    })));
    setSelectedKeys(new Set());
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
          <div className="flex gap-1">{[0, 1, 2, 3].map((index) => <Skeleton className="h-6 w-20 rounded-full" key={index} />)}</div>
          {[0, 1, 2].map((index) => <WorkbenchFeedbackReportSkeleton index={index} key={index} />)}
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
              <RadioRow
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
                key={keyOf(item)}
                modelName={modelName(item.harness, item.model)}
                onToggle={() => toggleSelected(keyOf(item))}
                selected={selectedKeys.has(keyOf(item))}
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
        addressBlocked={addressProjectId ? null : local.some(({ projectId }) => !projectId)
          ? "Some selected feedback belongs to a project this machine has no folder for."
          : "The selected feedback belongs to more than one project; address one project at a time."}
        busy={busy}
        error={actionError}
        onAddress={address}
        onDelete={() => void deleteSelected()}
        selection={selected.length ? { counts: countFeedbackCategories(selected), total: selected.length } : null}
      />
    </section>
  );
}
