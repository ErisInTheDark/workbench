/*
 * Exports:
 * - default ThreadBubbleCopyButton: copy the explicit source Markdown of one aligned user bubble with shared feedback.
 */
"use client";

import { useCallback, useEffect, useRef } from "react";

import { CheckIcon, CopyIcon, WarningIcon } from "../workbench-icons";
import { bubbleCopyFeedbackController } from "./bubble-copy";

const controlClassName = [
  "group inline-flex size-7 items-center justify-center rounded-full",
  "bg-[color-mix(in_srgb,var(--text)_4%,var(--bg))] [--fg-bg:color-mix(in_srgb,var(--text)_4%,var(--bg))] text-fg/muted",
  "transition-[background-color,color] duration-200",
  "hover:bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg))] hover:text-accent",
  "focus-visible:bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg))] focus-visible:text-accent focus-visible:outline-none",
  "motion-reduce:transition-colors",
].join(" ");

export default function ThreadBubbleCopyButton({
  markdown,
  side,
}: {
  markdown: string;
  side: "left" | "right";
}) {
  const unregisterRef = useRef<(() => void) | null>(null);
  const setButtonRef = useCallback((button: HTMLButtonElement | null) => {
    unregisterRef.current?.();
    unregisterRef.current = button
      ? bubbleCopyFeedbackController.register(button)
      : null;
  }, []);

  useEffect(() => () => {
    unregisterRef.current?.();
    unregisterRef.current = null;
  }, []);

  const copyMarkdown = useCallback((button: HTMLButtonElement) => {
    void bubbleCopyFeedbackController.copy(button, markdown);
  }, [markdown]);

  if (!markdown.trim()) return null;
  return (
    <div
      className={[
        "absolute top-0 z-[11] flex -translate-y-1/2 items-center gap-1 opacity-0 pointer-events-none",
        side === "left" ? "left-9" : "right-9",
        "transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
        side === "left"
          ? "group-hover/thread-bubble:-translate-x-0.5 group-focus-within/thread-bubble:-translate-x-0.5"
          : "group-hover/thread-bubble:translate-x-0.5 group-focus-within/thread-bubble:translate-x-0.5",
        "group-hover/thread-bubble:translate-y-[calc(-50%-0.125rem)] group-hover/thread-bubble:opacity-100 group-hover/thread-bubble:pointer-events-auto",
        "group-focus-within/thread-bubble:translate-y-[calc(-50%-0.125rem)] group-focus-within/thread-bubble:opacity-100 group-focus-within/thread-bubble:pointer-events-auto",
        "motion-reduce:!translate-x-0 motion-reduce:!translate-y-[-50%] motion-reduce:transition-opacity",
      ].join(" ")}
      data-thread-bubble-controls={side}
    >
      <button
        ref={setButtonRef}
        type="button"
        aria-label="Copy message"
        className={`${controlClassName} data-[thread-bubble-copy-state=copied]:text-success data-[thread-bubble-copy-state=failed]:text-danger`}
        data-thread-bubble-copy-button="true"
        data-thread-bubble-copy-side={side}
        data-thread-bubble-copy-state="idle"
        onClick={(event) => {
          copyMarkdown(event.currentTarget);
        }}
        title="Copy message"
      >
        <span className="block group-data-[thread-bubble-copy-state=copied]:hidden group-data-[thread-bubble-copy-state=failed]:hidden">
          <CopyIcon size={16} />
        </span>
        <span className="hidden group-data-[thread-bubble-copy-state=copied]:block">
          <CheckIcon size={16} />
        </span>
        <span className="hidden group-data-[thread-bubble-copy-state=failed]:block">
          <WarningIcon size={16} />
        </span>
      </button>
    </div>
  );
}
