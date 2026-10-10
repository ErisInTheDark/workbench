/*
 * Exports:
 * - default ThreadCommentaryActionRow: zero-space, hover-revealed action row beneath one commentary prose run.
 */
"use client";

import { useCallback, useEffect, useRef } from "react";

import { createCopyFeedbackController } from "../../../workbench/dom/clipboard-copy-feedback";
import { CheckIcon, CopyIcon, WarningIcon } from "../workbench-icons";
import IconButton from "../../ui/IconButton";

const commentaryCopyFeedbackController = createCopyFeedbackController({
  attribute: "data-thread-commentary-copy-state",
  copiedLabel: "Copied commentary",
  label: "Copy commentary",
});

export default function ThreadCommentaryActionRow({
  markdown,
  placement,
}: {
  markdown: string;
  /** `end` hangs below a commentary item's section; `break` hangs from a section break into the gap above it. */
  placement: "break" | "end";
}) {
  const unregisterRef = useRef<(() => void) | null>(null);
  const setButtonRef = useCallback((button: HTMLButtonElement | null) => {
    unregisterRef.current?.();
    unregisterRef.current = button ? commentaryCopyFeedbackController.register(button) : null;
  }, []);
  useEffect(() => () => {
    unregisterRef.current?.();
    unregisterRef.current = null;
  }, []);

  return (
    <div
      className={`
        pointer-events-none absolute left-0 z-[11] flex items-center gap-1 opacity-0
        transition-opacity duration-200
        group-hover/commentary:(pointer-events-auto opacity-100)
        group-focus-within/commentary:(pointer-events-auto opacity-100)
        ${placement === "end" ? "top-[calc(100%-0.5rem)]" : "-top-[0.9em]"}
      `}
      data-thread-commentary-actions={placement}
    >
      <IconButton
        ref={setButtonRef}
        className={`
          group
          data-[thread-commentary-copy-state=copied]:text-success
          data-[thread-commentary-copy-state=failed]:text-danger
        `}
        display="hover-border"
        label="Copy commentary"
        onClick={(event) => { void commentaryCopyFeedbackController.copy(event.currentTarget, markdown); }}
        size="compact"
      >
        <span className="block group-data-[thread-commentary-copy-state=copied]:hidden group-data-[thread-commentary-copy-state=failed]:hidden">
          <CopyIcon size={14} />
        </span>
        <span className="hidden group-data-[thread-commentary-copy-state=copied]:block">
          <CheckIcon size={14} />
        </span>
        <span className="hidden group-data-[thread-commentary-copy-state=failed]:block">
          <WarningIcon size={14} />
        </span>
      </IconButton>
    </div>
  );
}
