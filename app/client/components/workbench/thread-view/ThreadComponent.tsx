/*
 * Exports:
 * - default ThreadComponent: render one message's stored native skill-component result.
 */
"use client";

import { Component, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { readThreadComponentRender, type ThreadComponentRender } from "workbench-shared/workbench/thread/thread-component-tree";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import WorkbenchWorkspaceContext, { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { renderThreadComponentNode } from "./thread-component-render";
import type { ThreadRenderOptions } from "./thread-markdown-render";
import { ThreadComponentStylesContext } from "./ThreadComponentStyles";

class RenderBoundary extends Component<{ children: ReactNode; fallback: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <span>{this.props.fallback}</span> : this.props.children; }
}

function ComponentTree({ tree, options }: { tree: ThreadComponentRender["tree"]; options?: ThreadRenderOptions }) {
  return renderThreadComponentNode(tree, options);
}

export default function ThreadComponent({ threadId, itemId, markup, sourceText, markdownOptions }: {
  threadId: string; itemId: string; markup: string; sourceText: string; markdownOptions?: ThreadRenderOptions;
}) {
  const daemon = useWorkbenchDaemonClient();
  const styles = useContext(ThreadComponentStylesContext);
  const workspace = useContext(WorkbenchWorkspaceContext);
  const query = useMemo(() => ({ kind: "thread" as const, threadId: ThreadReferenceSchema.parse(threadId) }), [threadId]);
  const observed = useWorkspaceObservation(workspace, query);
  const skillKey = JSON.stringify(observed.value?.runtime[threadId]?.skills ?? []);
  const key = JSON.stringify([threadId, itemId, markup]);
  const sourceReady = sourceText.replaceAll("\r\n", "\n").includes(markup);
  const [state, setState] = useState<{ key: string; result: ThreadComponentRender | null; error: string | null }>({
    key, result: null, error: null,
  });

  useEffect(() => {
    if (!sourceReady || (state.key === key && state.result)) return;
    let current = true;
    setState(previous => previous.key === key && previous.result ? previous : { key, result: null, error: null });
    void daemon.threads.components.render({ threadId: ThreadReferenceSchema.parse(threadId), itemId, markup }).then(
      async result => {
        if (!current) return;
        try {
          const parsed = readThreadComponentRender(result);
          if (!styles) throw new Error("Thread component styles are unavailable.");
          await styles.ensure(parsed.styleRevisions);
          if (current) setState({ key, result: parsed, error: null });
        }
        catch (error) { if (current) setState({ key, result: null, error: error instanceof Error ? error.message : "Component render failed." }); }
      },
      error => { if (current) setState({ key, result: null, error: error instanceof Error ? error.message : "Component render failed." }); },
    );
    return () => { current = false; };
  }, [daemon, itemId, key, markup, skillKey, sourceReady, styles, threadId]);

  if (state.key !== key || !state.result) return <span title={state.error ?? undefined}>{state.error ? markup : ""}</span>;
  const { tree } = state.result;
  return (
    <RenderBoundary fallback={markup} key={key}>
      <div data-wb-component="true">
        <ComponentTree tree={tree} options={markdownOptions} />
      </div>
    </RenderBoundary>
  );
}
