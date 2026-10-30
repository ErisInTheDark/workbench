/*
 * Exports:
 * - ThreadSkillItemContext: the call item whose line is drawing, so its inline skill components can be kept on it.
 * - useThreadSkillInlineParts: draw a line's inline skill components: rendered once per props by the daemon (one request
 *   per line) and kept on the call's item, a vis preview's own drawing, or their stand-in text until then.
 */
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { readThreadComponentRender, type ThreadComponentRender } from "workbench-shared/workbench/thread/thread-component-tree";
import type { CommandSkillComponentDisplayPart, ThreadCommandDisplayPart } from "../../../workbench/thread/command-matchers/types";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import { TranscriptScopeContext } from "../use-transcript";
import ThreadComponentTree from "./ThreadComponentTree";
import { ThreadComponentStylesContext } from "./ThreadComponentStyles";
import { ThreadSkillComponentPreviewContext } from "./ThreadSkillCallComponent";

export const ThreadSkillItemContext = createContext<string | null>(null);

type Trees = { key: string; trees: ThreadComponentRender["tree"][] | null; error: string | null };

const isSkillComponent = (part: ThreadCommandDisplayPart): part is CommandSkillComponentDisplayPart => part.type === "skillComponent";

/** Returns how to draw each inline part; anything outside a call's line (live status, plain surfaces) shows its text. */
export function useThreadSkillInlineParts(parts: readonly ThreadCommandDisplayPart[]): (part: CommandSkillComponentDisplayPart, fallback: ReactNode) => ReactNode {
  const preview = useContext(ThreadSkillComponentPreviewContext);
  const itemId = useContext(ThreadSkillItemContext);
  const threadId = useContext(TranscriptScopeContext)?.threadId ?? null;
  const styles = useContext(ThreadComponentStylesContext);
  const daemon = useWorkbenchDaemonClient();
  const inline = parts.filter(isSkillComponent);
  const skillPath = inline[0]?.skillPath ?? null;
  const key = !preview && inline.length && itemId && threadId && skillPath
    ? JSON.stringify([threadId, itemId, skillPath, inline.map(part => [part.component, part.props])])
    : null;
  const [state, setState] = useState<Trees>({ key: "", trees: null, error: null });
  useEffect(() => {
    if (!key || !itemId || !threadId || !skillPath || (state.key === key && state.trees)) return;
    let current = true;
    void daemon.threads.components.renderInline({
      threadId: ThreadReferenceSchema.parse(threadId), itemId, skillPath,
      parts: inline.map(part => ({ component: part.component, props: part.props })),
    }).then(async ({ renders }) => {
      const parsed = renders.map(render => readThreadComponentRender(render));
      await styles?.ensure(parsed.flatMap(render => render.styleRevisions));
      if (current) setState({ key, trees: parsed.map(render => render.tree), error: null });
    }).catch((error: unknown) => {
      if (current) setState({ key, trees: null, error: error instanceof Error ? error.message : "Inline components failed to render." });
    });
    return () => { current = false; };
    // `inline` is rebuilt every render; `key` names it.
  }, [key, styles]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = state.key === key ? state : null;
  return (part, fallback) => {
    if (preview) return preview({ component: part.component, fallback, props: part.props, inline: true });
    const tree = shown?.trees?.[inline.indexOf(part)];
    if (tree) return <ThreadComponentTree fallback={fallback} inline tree={tree} />;
    // A failed render keeps the stand-in, saying why on hover.
    return shown?.error ? <span title={`${part.component} could not render: ${shown.error.slice(0, 300)}`}>{fallback}</span> : fallback;
  };
}
