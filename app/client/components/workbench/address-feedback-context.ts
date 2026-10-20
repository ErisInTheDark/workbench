/*
 * Exports:
 * - WorkbenchFeedbackAddressing: where feedback can be addressed from the current surface.
 * - WorkbenchFeedbackAddressingContext: the app provides addressing in a new thread; a thread view adds addressing in itself.
 */
"use client";

import { createContext } from "react";

import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";

export interface WorkbenchFeedbackAddressing {
  /** Attach the report to this thread's next message; null outside a thread with a composer. */
  here: ((report: WorkbenchThreadAddressedFeedback) => void) | null;
  /** Open a new thread in the project with its composer holding the reports. */
  inNewThread: ((projectId: string, reports: readonly WorkbenchThreadAddressedFeedback[]) => void) | null;
}

export const WorkbenchFeedbackAddressingContext = createContext<WorkbenchFeedbackAddressing>({ here: null, inNewThread: null });
