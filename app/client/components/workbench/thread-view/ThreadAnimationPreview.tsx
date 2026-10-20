/*
 * Exports:
 * - default ThreadAnimationPreview: loop a short scripted reply (heading, paragraph, notice, then a command run) through the real thread markdown renderer in one animation style; a typewriter caret waits below the running command.
 */
"use client";

import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import type { WorkbenchThreadAnimationStyle } from "workbench-shared/workbench/settings/workbench-setting-definitions";
import { THREAD_ANIMATION_STYLES } from "../../../workbench/thread/thread-animation-styles";
import MarkdownRender from "../../ui/MarkdownRender";
import { CheckIcon, LoaderIcon, TerminalIcon } from "../workbench-icons";
import ThreadAnimationStyleContext from "./ThreadAnimationStyleContext";
import { ThreadEntryAnimation, ThreadStreamCaretSlot } from "./ThreadRevealText";

const SCRIPT = [
  "### Tracing the reveal",
  "",
  "Words land softly as the agent streams.",
  "",
  "<notice title=\"Heads up\" color=\"yellow\">",
  "Notices wait for their first block.",
  "</notice>",
].join("\n");
/** Whole-word growth, like the live text presentation controller reveals deltas. */
const TOKEN_ENDS = [...SCRIPT.matchAll(/\s*\S+\s*/g)].map(match => match.index + match[0].length);
const TOKEN_MS = 95;
const COMMAND_DELAY_MS = 220;
const COMMAND_RUN_MS = 750;
const REST_MS = 1800;

type Phase = { kind: "streaming"; tokens: number } | { kind: "command"; settled: boolean };

/** One pass of the script; remounting it restarts the loop. */
function PreviewPass({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "streaming", tokens: 0 });
  const caret = useContext(ThreadAnimationStyleContext).caret;
  useEffect(() => {
    const streamEnd = TOKEN_ENDS.length * TOKEN_MS;
    const timers = TOKEN_ENDS.map((_, index) => window.setTimeout(() => setPhase({ kind: "streaming", tokens: index + 1 }), (index + 1) * TOKEN_MS));
    timers.push(window.setTimeout(() => setPhase({ kind: "command", settled: false }), streamEnd + COMMAND_DELAY_MS));
    timers.push(window.setTimeout(() => setPhase({ kind: "command", settled: true }), streamEnd + COMMAND_DELAY_MS + COMMAND_RUN_MS));
    timers.push(window.setTimeout(onDone, streamEnd + COMMAND_DELAY_MS + COMMAND_RUN_MS + REST_MS));
    return () => timers.forEach(clearTimeout);
  }, [onDone]);
  const streaming = phase.kind === "streaming";
  const markdown = streaming ? SCRIPT.slice(0, TOKEN_ENDS[phase.tokens - 1] ?? 0) : SCRIPT;
  return <>
    <ThreadEntryAnimation play>
      <MarkdownRender live markdown={markdown} streaming={streaming} />
    </ThreadEntryAnimation>
    {phase.kind === "command" ? <ThreadEntryAnimation play>
      <span className="mt-1 flex items-center gap-1.5 rounded-md bg-fg/6 px-2 py-1 font-mono text-[0.85em]">
        <TerminalIcon size={12} className="shrink-0 text-fg/muted" />
        <span className="min-w-0 flex-1 truncate">pnpm typecheck</span>
        {phase.settled ? <span className="text-success"><CheckIcon size={12} /></span> : <LoaderIcon size={12} className="shrink-0 text-fg/muted" />}
      </span>
    </ThreadEntryAnimation> : null}
    {caret && phase.kind === "command" && !phase.settled ? <span className="mt-1 block"><ThreadStreamCaretSlot /></span> : null}
  </>;
}

export default function ThreadAnimationPreview({ perParagraph, style }: { perParagraph: boolean; style: WorkbenchThreadAnimationStyle }) {
  const [pass, setPass] = useState(0);
  const animation = useMemo(() => ({ ...THREAD_ANIMATION_STYLES[style], perParagraph }), [perParagraph, style]);
  const restart = useCallback(() => setPass(value => value + 1), []);
  return <ThreadAnimationStyleContext value={animation}>
    <PreviewPass key={`${style}-${perParagraph}-${pass}`} onDone={restart} />
  </ThreadAnimationStyleContext>;
}
