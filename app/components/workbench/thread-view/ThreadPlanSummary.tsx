/*
 * Exports:
 * - default ThreadPlanSummary: render a plan disclosure label with a source-markdown copy action. Keywords: thread, plan, summary, copy, clipboard.
 */
"use client";

import { useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../../workbench/dom/clipboard";
import { CheckIcon, CopyIcon } from "../workbench-icons";

const COPY_FEEDBACK_MS = 1500;

type PlanCopyState = "copied" | "failed" | "idle";

function getCopyButtonLabel(state: PlanCopyState) {
  if (state === "copied") return "Copied plan";
  if (state === "failed") return "Plan copy failed";
  return "Copy plan";
}

export default function ThreadPlanSummary ({ markdown }: { markdown: string }) {
  const [copyState, setCopyState] = useState<PlanCopyState>("idle");
  const copyAttemptRef = useRef(0);
  const feedbackTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyAttemptRef.current += 1;
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  async function copyPlan () {
    const copyAttempt = copyAttemptRef.current + 1;
    copyAttemptRef.current = copyAttempt;
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }

    const didCopy = await writeTextToClipboard(markdown);
    if (!mountedRef.current || copyAttemptRef.current !== copyAttempt) {
      return;
    }

    setCopyState(didCopy ? "copied" : "failed");
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setCopyState("idle");
    }, COPY_FEEDBACK_MS);
  }

  const copyButtonLabel = getCopyButtonLabel(copyState);

  return (
    <div className="flex min-w-0 w-full items-center justify-between gap-2">
      <span className="min-w-0 truncate">Plan</span>
      <button
        aria-label={copyButtonLabel}
        className="inline-flex size-[1.65rem] shrink-0 items-center justify-center rounded-[0.38rem] text-muted transition-[background-color,color,opacity] duration-150 ease-out hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none data-[thread-plan-copy-state=copied]:text-success data-[thread-plan-copy-state=failed]:text-danger"
        data-thread-plan-copy="true"
        data-thread-plan-copy-state={copyState}
        onClick={() => { void copyPlan(); }}
        title={copyButtonLabel}
        type="button"
      >
        {copyState === "copied" ? <CheckIcon className="size-[1.2rem]" /> : <CopyIcon className="size-[1.2rem]" />}
      </button>
    </div>
  );
}
