/*
 * Exports:
 * - ThreadSkillItemContext: the call item whose line is drawing; inline skill components draw only inside one.
 * - useThreadSkillInlineParts: draw a line's inline skill components, each rendered from its props, a vis preview's own
 *   drawing, or their stand-in text until then and anywhere outside a call's line (live status, plain surfaces).
 */
"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { CommandSkillComponentDisplayPart } from "../../../workbench/thread/command-matchers/types";
import ThreadComponentTree from "./ThreadComponentTree";
import { ThreadSkillComponentPreviewContext } from "./ThreadSkillCallComponent";
import { useThreadSkillComponent } from "./ThreadSkillExtensions";

export const ThreadSkillItemContext = createContext<string | null>(null);

function ThreadSkillInlinePart({ fallback, part }: { fallback: ReactNode; part: CommandSkillComponentDisplayPart }) {
  const key = JSON.stringify(["inline", part.skillPath, part.component, part.props]);
  const state = useThreadSkillComponent(key, { kind: "inline", skillPath: part.skillPath, component: part.component, props: part.props });
  if (state.status === "ready") return <ThreadComponentTree fallback={fallback} inline tree={state.tree} />;
  // A failed render keeps the stand-in, saying why on hover.
  return state.status === "failed" ? <span title={`${part.component} could not render: ${state.error.slice(0, 300)}`}>{fallback}</span> : fallback;
}

export function useThreadSkillInlineParts(): (part: CommandSkillComponentDisplayPart, fallback: ReactNode) => ReactNode {
  const preview = useContext(ThreadSkillComponentPreviewContext);
  const inLine = useContext(ThreadSkillItemContext) !== null;
  return (part, fallback) => {
    if (preview) return preview({ component: part.component, fallback, props: part.props, inline: true });
    return inLine ? <ThreadSkillInlinePart fallback={fallback} part={part} /> : fallback;
  };
}
