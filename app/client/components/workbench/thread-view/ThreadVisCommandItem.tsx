/*
 * Exports:
 * - default ThreadVisCommandItem: a vis call as one step line: a start or end opens into the document snapshotted at that
 *   moment, a state read or browser snapshot into what the agent read, and a screenshot into the image the agent saw (its
 *   delivery is transcript-hidden, so this is its only place).
 * - ThreadVisSnapshotRow: the completed start or end step over its snapshot, shared with the user's card-end item.
 */
"use client";

import { useContext, useMemo, type ReactNode } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { parseVisScreenshotImage, parseVisSessionResult } from "workbench-shared/workbench/vis/vis-contract";
import type { WorkbenchVisOperation } from "../../../workbench/thread/thread-command-matchers";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import WorkbenchWorkspaceContext from "../WorkbenchWorkspaceContext";
import { WallpaperIcon } from "../workbench-icons";
import ThreadStepRow from "./ThreadStepRow";
import { isFailedStep, stepLabel, stepLabels, type StepLabels, type StepState } from "./thread-step";
import ThreadUserImage from "./ThreadUserImage";
import ThreadVisFrame from "./ThreadVisFrame";

/** Mounts only once the disclosure opens, so the stored document is read on demand. */
function VisSnapshotContent({ sessionId, snapshotKind, threadId }: { sessionId: string; snapshotKind: "start" | "end"; threadId: string }) {
  const workspace = useContext(WorkbenchWorkspaceContext);
  const query = useMemo(() => ({
    kind: "visSnapshot" as const, threadId: ThreadReferenceSchema.parse(threadId), sessionId, snapshotKind,
  }), [sessionId, snapshotKind, threadId]);
  const snapshot = useWorkspaceObservation(workspace, query);
  const data = snapshot.value?.data ?? null;
  if (!data) {
    return snapshot.failure
      ? <p className="m-0 text-[0.78em] text-fg/muted">The snapshot is unavailable: {snapshot.failure}</p>
      : <div aria-hidden="true" className="h-48 animate-pulse rounded-[0.65rem] bg-fg/4 motion-reduce:animate-none" />;
  }
  return (
    <div className="space-y-1">
      {data.document !== null
        ? <ThreadVisFrame className="rounded-[0.65rem] bg-fg/4" document={data.document} title={`Vis snapshot of ${data.path}`} />
        : null}
      {data.failure ? <p className="m-0 text-[0.78em] text-fg/muted">{data.failure}</p> : null}
    </div>
  );
}

const LABELS: Record<WorkbenchVisOperation["action"], StepLabels> = {
  start: stepLabels("Starting vis on", "Started vis on", "Failed to start vis on"),
  end: stepLabels("Ending vis on", "Ended vis on", "Failed to end vis on"),
  read: stepLabels("Reading answers from", "Read answers from", "Failed to read answers from"),
  snapshot: stepLabels("Checking vis structure", "Checked vis structure", "Failed to check vis structure"),
  screenshot: stepLabels("Checking vis appearance", "Checked vis appearance", "Failed to check vis appearance"),
};

/** One vis step: the vis glyph (as the status row shows live vis), what happened to which file, then progress. */
function VisStep({ action, children, durationMs, path, renderContent, state }: {
  action: WorkbenchVisOperation["action"];
  children?: ReactNode;
  durationMs: number | null;
  path: string;
  renderContent?: () => ReactNode;
  state: StepState;
}) {
  return (
    <ThreadStepRow
      icon={<WallpaperIcon size={16} />}
      iconClassName={isFailedStep(state) ? "text-danger" : undefined}
      label={stepLabel(LABELS[action], state)}
      progress={{ durationMs, state }}
      renderContent={renderContent}
      subject={<span className="min-w-0 truncate font-mono text-[0.92em] text-text">{path}</span>}
    >
      {children}
    </ThreadStepRow>
  );
}

/** A completed vis start or end, opening into the document snapshotted at that moment. */
export function ThreadVisSnapshotRow({ durationMs, path, sessionId, snapshotKind, threadId }: {
  durationMs: number | null;
  path: string;
  sessionId: string;
  snapshotKind: "start" | "end";
  threadId: string;
}) {
  return (
    <VisStep
      action={snapshotKind}
      durationMs={durationMs}
      path={path}
      renderContent={() => <VisSnapshotContent sessionId={sessionId} snapshotKind={snapshotKind} threadId={threadId} />}
      state="completed"
    />
  );
}

export default function ThreadVisCommandItem({ durationMs, operation, outcome, output, threadId }: {
  durationMs: number | null;
  operation: WorkbenchVisOperation;
  outcome: "completed" | "failed" | "inProgress";
  /** The call's acknowledgement, which names the session. */
  output: string;
  threadId: string;
}) {
  const result = parseVisSessionResult(output);
  const step = { action: operation.action, durationMs, path: operation.path, state: outcome };
  const screenshot = operation.action === "screenshot" && outcome === "completed" ? parseVisScreenshotImage(output) : null;
  if (screenshot) return <VisStep {...step} renderContent={() => <ThreadUserImage alt={`Screenshot of ${operation.path}`} src={screenshot} />} />;
  if ((operation.action === "read" || operation.action === "snapshot") && outcome === "completed") {
    return <VisStep {...step} renderContent={() => <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[0.8em] text-fg/muted">{output.trim()}</pre>} />;
  }
  if (outcome === "failed") {
    return output.trim()
      ? <VisStep {...step}><p className="m-0 text-[0.86em] text-fg/muted">{output.trim().slice(0, 500)}</p></VisStep>
      : <VisStep {...step} />;
  }
  if (!result || outcome !== "completed") return <VisStep {...step} />;
  return <ThreadVisSnapshotRow durationMs={durationMs} path={operation.path} sessionId={result.sessionId} snapshotKind={result.kind} threadId={threadId} />;
}
