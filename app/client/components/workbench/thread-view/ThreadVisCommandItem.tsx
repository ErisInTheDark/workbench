/*
 * Exports:
 * - default ThreadVisCommandItem: render a vis start or end call as a closed disclosure that shows the document snapshotted at that
 *   moment, an answer read or browser snapshot as one that shows what the agent read, and a screenshot as one that shows the
 *   image the agent saw (its delivery is transcript-hidden, so this is its only place).
 * - ThreadVisSnapshotRow: the completed start or end row over its snapshot, shared with the user's card-end item.
 */
"use client";

import { useContext, useMemo } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { parseVisScreenshotImage, parseVisSessionResult } from "workbench-shared/workbench/vis/vis-contract";
import type { WorkbenchVisOperation } from "../../../workbench/thread/thread-command-matchers";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import WorkbenchWorkspaceContext from "../WorkbenchWorkspaceContext";
import Disclosure from "../../ui/Disclosure";
import ThreadDurationText from "./ThreadDurationText";
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

const VERBS: Record<WorkbenchVisOperation["action"], Record<"completed" | "failed" | "inProgress", string>> = {
  start: { inProgress: "Starting vis on", failed: "Could not start vis on", completed: "Started vis on" },
  end: { inProgress: "Ending vis on", failed: "Could not end vis on", completed: "Ended vis on" },
  read: { inProgress: "Reading answers from", failed: "Could not read answers from", completed: "Read answers from" },
  snapshot: { inProgress: "Checking vis structure", failed: "Could not check vis structure", completed: "Checked vis structure" },
  screenshot: { inProgress: "Checking vis appearance", failed: "Could not check vis appearance", completed: "Checked vis appearance" },
};

function VisSummary({ durationMs, path, verb }: { durationMs: number | null; path: string; verb: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{verb}</span>
      <span className="min-w-0 truncate font-mono text-[0.92em] text-text">{path}</span>
      {durationMs === null ? null : <ThreadDurationText className="shrink-0 text-[0.78em] text-fg/muted" durationMs={durationMs} />}
    </span>
  );
}

/** A completed vis start or end: a closed disclosure over the document snapshotted at that moment. */
export function ThreadVisSnapshotRow({ durationMs, path, sessionId, snapshotKind, threadId }: {
  durationMs: number | null;
  path: string;
  sessionId: string;
  snapshotKind: "start" | "end";
  threadId: string;
}) {
  return (
    <Disclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      renderContent={() => <VisSnapshotContent sessionId={sessionId} snapshotKind={snapshotKind} threadId={threadId} />}
      summary={<VisSummary durationMs={durationMs} path={path} verb={VERBS[snapshotKind].completed} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
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
  const summary = <VisSummary durationMs={durationMs} path={operation.path} verb={VERBS[operation.action][outcome]} />;
  const screenshot = operation.action === "screenshot" && outcome === "completed" ? parseVisScreenshotImage(output) : null;
  if (screenshot) {
    return (
      <Disclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        renderContent={() => <ThreadUserImage alt={`Screenshot of ${operation.path}`} src={screenshot} />}
        summary={summary}
        summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      />
    );
  }
  if ((operation.action === "read" || operation.action === "snapshot") && outcome === "completed") {
    return (
      <Disclosure
        className="py-2"
        contentClassName="mt-2 pl-6"
        renderContent={() => <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[0.8em] text-fg/muted">{output.trim()}</pre>}
        summary={summary}
        summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      />
    );
  }
  if (!result || outcome !== "completed") {
    return (
      <div className="py-2 text-[0.92em] leading-[1.6] text-fg/muted">
        {summary}
        {outcome === "failed" && output ? <p className="m-0 mt-1 pl-6 text-[0.86em]">{output.trim().slice(0, 500)}</p> : null}
      </div>
    );
  }
  return <ThreadVisSnapshotRow durationMs={durationMs} path={operation.path} sessionId={result.sessionId} snapshotKind={result.kind} threadId={threadId} />;
}
