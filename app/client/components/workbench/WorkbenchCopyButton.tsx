/*
 * Default export:
 * - WorkbenchCopyButton: copy text on HTTP or HTTPS with accessible success/failure feedback.
 */
"use client";
import { useCallback, useMemo } from "react";
import { createCopyFeedbackController } from "../../workbench/dom/clipboard-copy-feedback";
import WorkbenchIconButton from "./WorkbenchIconButton";
import { CheckIcon, CopyIcon, WarningIcon } from "./workbench-icons";

export default function WorkbenchCopyButton({ text, label }: { text: string; label: string }) {
  const controller = useMemo(() => createCopyFeedbackController({ label }), [label]);
  const ref = useCallback((button: HTMLButtonElement | null) => button ? controller.register(button) : undefined, [controller]);
  return <WorkbenchIconButton ref={ref} label={label} size="small" display="hover-border"
    className="group data-[copy-state=copied]:text-success data-[copy-state=failed]:text-danger"
    onClick={event => { void controller.copy(event.currentTarget, text); }}>
    <CopyIcon className="size-4 group-data-[copy-state=copied]:hidden group-data-[copy-state=failed]:hidden" />
    <CheckIcon className="hidden size-4 group-data-[copy-state=copied]:block" />
    <WarningIcon className="hidden size-4 group-data-[copy-state=failed]:block" />
  </WorkbenchIconButton>;
}
