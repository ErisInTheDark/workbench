/*
 * Exports:
 * - default ThreadComponent: draw one message's skill-component invocation once its markup is complete; its markup shows
 *   instead when it cannot render.
 */
"use client";

import type { ThreadRenderOptions } from "./thread-markdown-render";
import ThreadComponentTree from "./ThreadComponentTree";
import { useThreadSkillComponent } from "./ThreadSkillExtensions";

export default function ThreadComponent({ itemId, markup, sourceText, markdownOptions }: {
  threadId: string; itemId: string; markup: string; sourceText: string; markdownOptions?: ThreadRenderOptions;
}) {
  // A streaming message shows the invocation only once its whole markup has arrived.
  const ready = sourceText.replaceAll("\r\n", "\n").includes(markup);
  const key = ready ? JSON.stringify(["message", itemId, markup]) : null;
  const state = useThreadSkillComponent(key, ready ? { kind: "message", itemId, markup } : null);
  if (state.status === "failed") return <span title={state.error}>{markup}</span>;
  if (state.status === "pending") return <span />;
  return <ThreadComponentTree fallback={<span>{markup}</span>} key={key} options={markdownOptions} tree={state.tree} />;
}
