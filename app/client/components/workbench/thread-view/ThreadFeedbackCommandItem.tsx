/*
 * Exports:
 * - default ThreadFeedbackCommandItem: a wb feedback call as a card: "Reported", its category, title and importance on the
 *   line, opening into the stored report with the stats view's actions for it: delete (hold), resolve and address here, or
 *   address in a new thread while Shift is held; reopen once resolved.
 */
"use client";

import { useContext, useState } from "react";

import type { WorkbenchFeedbackOperation } from "../../../workbench/thread/thread-command-matchers";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { WorkbenchFeedbackAddressingContext } from "../address-feedback-context";
import { FEEDBACK_TEXT_TONE_CLASS_NAME } from "../feedback-presentation";
import useStats from "../stats/use-stats";
import type { StatsFeedbackReportSnapshot } from "../stats/WorkbenchStatsStore";
import { deleteFeedbackReports, setFeedbackReportsResolved } from "../stats/workspaces/feedback-report-mutations";
import { feedbackReference } from "../stats/workspaces/stats-feedback-presentation";
import {
  WorkbenchFeedbackImportance,
  WorkbenchFeedbackReportBody,
  WorkbenchFeedbackReportDisplay,
  WorkbenchFeedbackReportSkeleton,
} from "../stats/workspaces/WorkbenchStatsFeedbackReport";
import WorkbenchStatsFeedbackTag from "../stats/workspaces/WorkbenchStatsFeedbackTag";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import WorkbenchWorkspaceContext from "../WorkbenchWorkspaceContext";
import { BinIcon, BotIcon, CheckIcon, MegaphoneIcon, Undo2Icon } from "../workbench-icons";
import { stepLabel, stepLabels } from "./thread-step";
import ThreadCard from "./ThreadCard";

const DELETE_HOLD_MS = 1_000;

type Ready = Extract<StatsFeedbackReportSnapshot, { status: "ready" }>;

interface ReportSource {
  feedbackId: number | null;
  threadId: string;
}

/** The stored report the call filed; one lease per report however many parts of the card read it. */
function useStoredReport({ feedbackId, threadId }: ReportSource) {
  return useStats.feedbackReport(feedbackId === null ? null : { feedbackId, threadId });
}

const LABELS = stepLabels("Reporting", "Reported", "Failed to report");

/** The stats view's actions for one report, in its order. */
function ReportActions({ modelName, projectId, report }: { modelName: string | null; projectId: string | null; report: Ready }) {
  const workspace = useContext(WorkbenchWorkspaceContext);
  const addressing = useContext(WorkbenchFeedbackAddressingContext);
  const { projectName } = useStats();
  const shiftHeld = useNonTextInputShiftKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { daemonId, item } = report;
  const stored = [{ daemonId, id: item.id }];
  const act = async (action: () => Promise<void> | void, fallback: string) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  const reference = () => feedbackReference(item, { daemonId, modelName, projectName: projectName(item.projectId, daemonId) });
  // wb reports are about Workbench, so a new thread for one opens in Workbench's project.
  const newThreadProjectId = item.channel === "wb" ? report.workbenchProjectId : projectId;
  const inNewThread = shiftHeld || !addressing.here;
  const addressBlocked = inNewThread
    ? !addressing.inNewThread ? "Open Workbench to address feedback in a new thread." : !newThreadProjectId ? "Workbench's project is not open here." : null
    : null;
  const address = (
    <span className="inline-flex">
      <PrimaryButton
        disabled={busy || addressBlocked !== null}
        onClick={() => void act(() => {
          if (inNewThread) addressing.inNewThread?.(newThreadProjectId!, [reference()]);
          else addressing.here?.(reference());
        }, "Unable to address the feedback.")}
        shape="compact"
      >
        <BotIcon className="mr-1.5" size={14} />{inNewThread ? "Address in new thread" : "Address here"}
      </PrimaryButton>
    </span>
  );
  const mutate = (run: (client: NonNullable<typeof workspace>) => Promise<void>, fallback: string) => {
    if (workspace) void act(() => run(workspace), fallback);
  };
  return (
    <>
      {error ? <span className="min-w-0 truncate text-danger" role="alert">{error}</span> : null}
      <PrimaryButton
        disabled={busy || !workspace}
        holdToConfirmMs={DELETE_HOLD_MS}
        onClick={() => mutate(client => deleteFeedbackReports(client, stored), "Unable to delete the feedback.")}
        shape="compact"
        tone="danger"
      >
        <BinIcon className="mr-1.5" size={14} />Delete
      </PrimaryButton>
      {item.resolvedAt === null ? (
        <>
          <PrimaryButton
            disabled={busy || !workspace}
            onClick={() => mutate(client => setFeedbackReportsResolved(client, stored, true), "Unable to resolve the feedback.")}
            shape="compact"
          >
            <CheckIcon className="mr-1.5" size={14} />Resolve
          </PrimaryButton>
          {addressBlocked ? <Tooltip content={addressBlocked} placement="top">{address}</Tooltip> : address}
        </>
      ) : (
        <PrimaryButton
          disabled={busy || !workspace}
          onClick={() => mutate(client => setFeedbackReportsResolved(client, stored, false), "Unable to reopen the feedback.")}
          shape="compact"
        >
          <Undo2Icon className="mr-1.5" size={14} />Reopen
        </PrimaryButton>
      )}
    </>
  );
}

/** Mounts only once the card opens. */
function ReportContent({ operation, outcome, projectId, source }: {
  operation: WorkbenchFeedbackOperation;
  outcome: "completed" | "inProgress";
  projectId: string | null;
  source: ReportSource;
}) {
  const report = useStoredReport(source);
  const ready = report?.status === "ready" ? report : null;
  const modelName = useStats.modelNames(ready?.item.harness ? [ready.item.harness] : []);
  if (ready) {
    const name = modelName(ready.item.harness, ready.item.model);
    return (
      <WorkbenchFeedbackReportBody
        actions={<ReportActions modelName={name} projectId={projectId} report={ready} />}
        clamp={false}
        heading={false}
        item={ready.item}
        modelName={name}
        showThread={false}
      />
    );
  }
  // A call still running has no stored report yet; one that finished without an id, or whose report is gone, shows what it filed.
  if (outcome === "inProgress" || report?.status === "loading") return <WorkbenchFeedbackReportSkeleton />;
  const note = report?.status === "deleted" ? "This report has since been deleted."
    : report?.status === "failed" ? `The stored report is unavailable: ${report.failure}` : null;
  return (
    <>
      <WorkbenchFeedbackReportDisplay
        category={operation.category}
        clamp={false}
        heading={false}
        projectId={projectId}
        report={operation.report}
        title={operation.title}
      />
      {note ? <p className="m-0 mt-1 text-[0.72rem] text-fg/muted">{note}</p> : null}
    </>
  );
}

export default function ThreadFeedbackCommandItem({
  defaultOpen = false,
  durationMs,
  feedbackId,
  operation,
  outcome,
  projectId = null,
  threadId,
}: {
  defaultOpen?: boolean;
  durationMs: number | null;
  /** The stored report's id from the call's acknowledgement; null until the call completes. */
  feedbackId: number | null;
  operation: WorkbenchFeedbackOperation;
  outcome: "completed" | "inProgress";
  projectId?: string | null;
  threadId: string;
}) {
  const source = { feedbackId, threadId };
  const report = useStoredReport(source);
  const stored = report?.status === "ready" ? report.item : null;
  return (
    <ThreadCard
      defaultOpen={defaultOpen}
      icon={<MegaphoneIcon size={16} />}
      iconClassName={FEEDBACK_TEXT_TONE_CLASS_NAME}
      label={stepLabel(LABELS, outcome)}
      meta={[stored ? <WorkbenchFeedbackImportance item={stored} key="importance" /> : null]}
      progress={{ durationMs, state: outcome }}
      subject={(
        <>
          <WorkbenchStatsFeedbackTag category={operation.category} size="compact" />
          <span className="min-w-0 truncate font-semibold text-text">{stored?.title ?? operation.title}</span>
        </>
      )}
    >
      <ReportContent operation={operation} outcome={outcome} projectId={projectId} source={source} />
    </ThreadCard>
  );
}
