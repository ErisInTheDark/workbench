/*
 * Exports:
 * - default ThreadAddressedFeedback: the feedback a thread addresses as todo-like rows: pick a report for the next message, detach it from the
 *   thread, or resolve it on its machine (which also detaches it), one at a time or all at once with hold-to-confirm.
 *   Until each is resolved or detached the thread cannot settle.
 */
"use client";

import { useContext, useState } from "react";

import { composerReferenceKey } from "workbench-shared/workbench/thread/composer-reference";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import IconButton from "../../ui/IconButton";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { setFeedbackReportsResolved } from "../stats/workspaces/feedback-report-mutations";
import { WorkbenchFeedbackReportDisplay } from "../stats/workspaces/WorkbenchStatsFeedbackReport";
import WorkbenchStatsFeedbackTag from "../stats/workspaces/WorkbenchStatsFeedbackTag";
import WorkbenchWorkspaceContext from "../WorkbenchWorkspaceContext";
import { FEEDBACK_TEXT_TONE_CLASS_NAME } from "../feedback-presentation";
import { CheckIcon, MegaphoneIcon, UnlinkIcon } from "../workbench-icons";
import { threadTodoRowClassNames as row } from "./ThreadTodoPanel";
import type { ThreadReferenceSelection } from "./use-thread-reference-selection";

const BULK_HOLD_MS = 700;

export default function ThreadAddressedFeedback ({ feedback, onDetach, selection }: {
  feedback: readonly WorkbenchThreadAddressedFeedback[];
  onDetach: (reports: readonly WorkbenchThreadAddressedFeedback[]) => Promise<void>;
  selection: ThreadReferenceSelection;
}) {
  const workspace = useContext(WorkbenchWorkspaceContext);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  if (!feedback.length) return null;
  const run = async (requested: readonly WorkbenchThreadAddressedFeedback[], resolve: boolean) => {
    const reports = requested.filter(report => !busy.has(composerReferenceKey(report)));
    if (!reports.length || (resolve && !workspace)) return;
    const keys = reports.map(composerReferenceKey);
    setBusy(current => new Set([...current, ...keys]));
    setError("");
    try {
      // Resolve first: a failed detach then leaves resolved reports still listed, never open reports silently dropped.
      if (resolve) await setFeedbackReportsResolved(workspace!, reports, true);
      await onDetach(reports);
      selection.deselect(reports);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : resolve ? "Unable to resolve the feedback." : "Unable to detach the feedback.");
    } finally {
      setBusy(current => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
    }
  };
  const anyBusy = feedback.some(report => busy.has(composerReferenceKey(report)));
  return (
    <div className="space-y-1 px-2 py-2" data-thread-addressed-feedback="true">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2">
        <p className="m-0 min-w-0 text-[0.72em] text-fg/muted">
          {feedback.length} addressed feedback {feedback.length === 1 ? "report" : "reports"} · resolve or detach before settling
        </p>
        {feedback.length > 1 ? (
          <span className="flex shrink-0 items-center gap-1">
            <PrimaryButton
              disabled={anyBusy}
              holdToConfirmMs={BULK_HOLD_MS}
              onClick={() => void run(feedback, false)}
              shape="compact"
              title="Hold to detach every report from this thread; the reports stay open"
            >
              <UnlinkIcon className="mr-1.5" size={14} />Detach all
            </PrimaryButton>
            <PrimaryButton
              disabled={anyBusy || !workspace}
              holdToConfirmMs={BULK_HOLD_MS}
              onClick={() => void run(feedback, true)}
              shape="compact"
              title="Hold to resolve every report and detach them from this thread"
            >
              <CheckIcon className="mr-1.5" size={14} />Resolve all
            </PrimaryButton>
          </span>
        ) : null}
      </div>
      <ul aria-label="Addressed feedback" className="m-0 list-none space-y-0.5 p-0">
        {feedback.map((report) => {
          const key = composerReferenceKey(report);
          const selected = selection.isSelected(report);
          const pending = busy.has(key);
          return (
            <li
              className={`
                ${row.row}
                ${selected ? "bg-accent-soft/60 ring-1 ring-inset ring-accent" : "hover:bg-fg/4 focus-within:bg-fg/5"}
                ${pending ? "opacity-60" : ""}
              `}
              key={key}
            >
              <button
                aria-label={`Attach feedback "${report.title}"`}
                aria-pressed={selected}
                className={`
                  ${row.marker} cursor-pointer rounded-md transition
                  hover:bg-fg/7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
                  ${selected ? "text-accent" : FEEDBACK_TEXT_TONE_CLASS_NAME}
                `}
                onClick={() => selection.toggle(report)}
                type="button"
              >
                <MegaphoneIcon size={14} />
              </button>
              <Tooltip
                content={(
                  <div className="max-h-[min(24rem,60vh)] w-max max-w-[min(32rem,80vw)] overflow-auto text-[0.84rem] text-text">
                    <WorkbenchFeedbackReportDisplay category={report.category} clamp={false} report={report.report} title={report.title} />
                    <p className="m-0 mt-2 text-[0.74rem] text-fg/muted">{report.author} · {report.thread}</p>
                  </div>
                )}
                placement="top"
              >
                <span className={`${row.text} flex items-center gap-2`} tabIndex={0}>
                  <WorkbenchStatsFeedbackTag category={report.category} size="compact" />
                  <span className="min-w-0 truncate">{report.title}</span>
                </span>
              </Tooltip>
              <span className="flex shrink-0 items-center">
                <IconButton
                  disabled={pending}
                  display="hover-border"
                  label={`Detach "${report.title}" from this thread`}
                  onClick={() => void run([report], false)}
                  size="small"
                >
                  <UnlinkIcon size={16} />
                </IconButton>
                <IconButton
                  disabled={pending || !workspace}
                  display="hover-border"
                  label={`Resolve "${report.title}"`}
                  onClick={() => void run([report], true)}
                  pendingHalo={pending}
                  size="small"
                >
                  <CheckIcon size={16} />
                </IconButton>
              </span>
            </li>
          );
        })}
      </ul>
      {error ? <p className="m-0 px-2 text-[0.74em] text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
