/* Exports: default ThreadCommandTerminal renders serialised, selectable live command history. */
"use client";
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import type { ThreadTextPresentationSource } from "../../../workbench/thread/ThreadTextPresentationController";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { writeTextToClipboard } from "../../../workbench/dom/clipboard";
import ThreadCommandTerminalController, { type TerminalRow } from "./ThreadCommandTerminalController";
import { getThreadTerminalEntries, type ThreadTerminalContext, type ThreadTerminalEntry, type ThreadTerminalRetention } from "./thread-live-activity";
import ThreadScrollViewport, { ThreadScrollViewportEnd } from "./ThreadScrollViewport";
import ThreadTerminalText from "./ThreadTerminalText";
import ThreadMeasuredContent from "./ThreadMeasuredContent";
import useThreadPresentedText from "./use-thread-presented-text";

function TerminalOutputSubscription({ entry, controller, presentationSource, threadId, turnId }: {
  entry: Pick<ThreadTerminalEntry, "id" | "output">;
  controller: ThreadCommandTerminalController;
  presentationSource?: ThreadTextPresentationSource | null;
  threadId: string;
  turnId: string;
}) {
  const output = useThreadPresentedText({
    canonicalText: entry.output, field: "commandExecutionOutput", itemId: entry.id,
    source: presentationSource, threadId, turnId,
  });
  useEffect(() => { controller.setOutput(entry.id, output); }, [controller, entry.id, output]);
  return null;
}

function selectedTerminalText(root: HTMLElement) {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode
    || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return "";
  return selection.toString();
}

const TerminalCommandRow = memo(function TerminalCommandRow({
  id, command, output, status, streamsOutput, commandExpanded, outputExpanded, firstRunning, controller,
  open, presentationSource, threadId, turnId,
}: Pick<TerminalRow, "id" | "command" | "output" | "status" | "streamsOutput" | "commandExpanded" | "outputExpanded"> & {
  firstRunning: boolean;
  controller: ThreadCommandTerminalController;
  open: boolean;
  presentationSource?: ThreadTextPresentationSource | null;
  threadId: string;
  turnId: string;
}) {
  return <div data-terminal-row={id} className={`shrink-0 ${firstRunning ? "mt-auto border-t border-fg-alpha/16" : ""}`}>
    <ThreadMeasuredContent>
    {open && streamsOutput && status === "inProgress" ? <TerminalOutputSubscription
      entry={{ id, output }} controller={controller} presentationSource={presentationSource} threadId={threadId} turnId={turnId}
    /> : null}
    <div className="min-w-0 max-w-full px-3 py-2">
      <ThreadTerminalText command failed={status === "failed"} text={command} expanded={commandExpanded} onExpand={() => controller.expand(id, "command")} />
      {output ? <div className="mt-1 pl-3">
        <ThreadTerminalText text={output} expanded={outputExpanded} onExpand={() => controller.expand(id, "output")} />
      </div> : null}
      {status === "declined" || status === "timedOut"
        ? <p className="m-0 text-[0.78em] text-danger">{status === "declined" ? "Declined" : "Timed out"}</p> : null}
    </div>
    </ThreadMeasuredContent>
  </div>;
});

export default function ThreadCommandTerminal({ items, context, retention, hasReasoning, open, presentationSource, threadId, turnId }: {
  items: readonly ThreadItem[];
  context: ThreadTerminalContext;
  retention: Omit<ThreadTerminalRetention, "now">;
  hasReasoning: boolean;
  open: boolean;
  presentationSource?: ThreadTextPresentationSource | null;
  threadId: string;
  turnId: string;
}) {
  const content = useRef<HTMLDivElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [controller] = useState(() => {
    const owner = new ThreadCommandTerminalController({
      measure: () => new Map(Array.from(content.current?.querySelectorAll<HTMLElement>("[data-terminal-row]") ?? [])
        .map(node => [node.dataset.terminalRow!, node.offsetTop])),
      animate: before => {
        const animations: Animation[] = [];
        try {
          for (const node of content.current?.querySelectorAll<HTMLElement>("[data-terminal-row]") ?? []) {
            const oldTop = before.get(node.dataset.terminalRow!);
            const delta = oldTop === undefined ? 6 : oldTop - node.offsetTop;
            if (oldTop !== undefined && Math.abs(delta) < 0.5) continue;
            animations.push(node.animate([
              { transform: `translateY(${delta}px)`, opacity: oldTop === undefined ? 0 : 1 },
              { transform: "translateY(0)", opacity: 1 },
            ], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }));
          }
          return animations;
        } catch (error) {
          for (const animation of animations) {
            void animation.finished.catch(() => { /* Cancellation belongs to this failed batch. */ });
            animation.cancel();
          }
          throw error;
        }
      },
    });
    if (open) owner.setEntries(getThreadTerminalEntries(items, { ...context, retention: { ...retention, now: Date.now() } }));
    return owner;
  });
  const rows = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const now = Date.now();
      const entries = getThreadTerminalEntries(items, { ...context, retention: { ...retention, now } });
      controller.setEntries(entries);
      const expiry = entries.reduce((next, entry) => Math.min(next, entry.expiresAt ?? Infinity), Infinity);
      if (Number.isFinite(expiry)) timer = setTimeout(refresh, Math.max(0, expiry - Date.now()));
    };
    refresh();
    return () => clearTimeout(timer);
  }, [controller, items, context, retention, open]);
  useLayoutEffect(() => { controller.configure(open, reducedMotion); }, [controller, open, reducedMotion]);
  useLayoutEffect(() => { controller.committed(); }, [controller, rows]);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => () => controller.dispose(), [controller]);

  const preserveSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 2 && selectedTerminalText(event.currentTarget)) event.preventDefault();
  };
  return <>
    <ThreadScrollViewport
      resetKey={turnId}
      className={`overscroll-contain [&_[data-thread-scroll-end=true]]:[scroll-margin-block-start:0] ${hasReasoning ? "flex-[1_1_70%] max-h-[70%]" : "flex-[1_1_100%] max-h-full"}`}
      contentClassName="flex min-w-0 flex-col"
    >
      <div
        ref={content}
        className="relative flex min-w-0 flex-1 flex-col"
        onPointerDown={preserveSelection}
        onContextMenu={event => {
          const text = selectedTerminalText(event.currentTarget);
          if (!text) return;
          event.preventDefault();
          event.stopPropagation();
          void writeTextToClipboard(text).then(success => {
            setCopyFailed(!success);
            if (!success) console.warn("Terminal selection could not be copied.");
          }, () => {
            setCopyFailed(true);
            console.warn("Terminal selection could not be copied.");
          });
        }}
      >
        {rows.map((row, index) => <TerminalCommandRow key={row.id}
          id={row.id} command={row.command} output={row.output} status={row.status}
          streamsOutput={row.streamsOutput} open={open} presentationSource={presentationSource} threadId={threadId} turnId={turnId}
          commandExpanded={row.commandExpanded} outputExpanded={row.outputExpanded}
          firstRunning={row.status === "inProgress" && rows[index - 1]?.status !== "inProgress"}
          controller={controller}
        />)}
        {copyFailed ? <p role="status" className="m-0 px-3 py-1 text-[0.78em] text-danger">Could not copy selection. Try your keyboard copy shortcut.</p> : null}
      </div>
      <ThreadScrollViewportEnd />
    </ThreadScrollViewport>
  </>;
}
