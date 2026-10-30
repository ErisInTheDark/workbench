/*
 * Exports:
 * - default ThreadComponent: render one message's stored native skill-component result.
 */
"use client";

import { useContext, useMemo } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import WorkbenchWorkspaceContext, { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import type { ThreadRenderOptions } from "./thread-markdown-render";
import ThreadComponentTree, { useThreadComponentRender } from "./ThreadComponentTree";

export default function ThreadComponent({ threadId, itemId, markup, sourceText, markdownOptions }: {
  threadId: string; itemId: string; markup: string; sourceText: string; markdownOptions?: ThreadRenderOptions;
}) {
  const daemon = useWorkbenchDaemonClient();
  const workspace = useContext(WorkbenchWorkspaceContext);
  const query = useMemo(() => ({ kind: "thread" as const, threadId: ThreadReferenceSchema.parse(threadId) }), [threadId]);
  const observed = useWorkspaceObservation(workspace, query);
  const key = JSON.stringify([threadId, itemId, markup]);
  const state = useThreadComponentRender({
    key,
    ready: sourceText.replaceAll("\r\n", "\n").includes(markup),
    refreshKey: JSON.stringify(observed.value?.runtime[threadId]?.skills ?? []),
    request: () => daemon.threads.components.render({ threadId: ThreadReferenceSchema.parse(threadId), itemId, markup }),
  });

  if (!state.result) return <span title={state.error ?? undefined}>{state.error ? markup : ""}</span>;
  return <ThreadComponentTree fallback={<span>{markup}</span>} key={key} options={markdownOptions} tree={state.result.tree} />;
}
