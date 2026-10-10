/*
 * Exports:
 * - default ThreadVisCommandItem: render a vis start or end call as a closed disclosure that shows the document snapshotted at that moment.
 */
"use client";

import { useContext, useMemo } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { parseVisSessionResult } from "workbench-shared/workbench/vis/vis-contract";
import type { WorkbenchVisOperation } from "../../../workbench/thread/thread-command-matchers";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import WorkbenchWorkspaceContext from "../WorkbenchWorkspaceContext";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
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
      : <div aria-hidden="true" className="h-[min(60vh,28rem)] animate-pulse rounded-lg bg-fg/5 motion-reduce:animate-none" />;
  }
  return (
    <div className="space-y-1">
      {data.document !== null
        ? <ThreadVisFrame className="h-[min(60vh,28rem)] rounded-lg" document={data.document} resizable title={`Vis snapshot of ${data.path}`} />
        : null}
      {data.failure ? <p className="m-0 text-[0.78em] text-fg/muted">{data.failure}</p> : null}
    </div>
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
  const verb = operation.action === "start"
    ? outcome === "inProgress" ? "Starting vis on" : outcome === "failed" ? "Could not start vis on" : "Started vis on"
    : outcome === "inProgress" ? "Ending vis on" : outcome === "failed" ? "Could not end vis on" : "Ended vis on";
  const summary = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{verb}</span>
      <span className="min-w-0 truncate font-mono text-[0.92em] text-text">{operation.path}</span>
      {durationMs === null ? null : <ThreadDurationText className="shrink-0 text-[0.78em] text-fg/muted" durationMs={durationMs} />}
    </span>
  );
  if (!result || outcome !== "completed") {
    return (
      <div className="py-2 text-[0.92em] leading-[1.6] text-fg/muted">
        {summary}
        {outcome === "failed" && output ? <p className="m-0 mt-1 pl-6 text-[0.86em]">{output.trim().slice(0, 500)}</p> : null}
      </div>
    );
  }
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      renderContent={() => <VisSnapshotContent sessionId={result.sessionId} snapshotKind={result.kind} threadId={threadId} />}
      summary={summary}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    />
  );
}
