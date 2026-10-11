/*
 * Exports:
 * - threadAttentionLabels: questionnaire labels by thread id from pinned summaries and sidebar rows.
 * - isThreadStatusActive/isThreadStatusWaitingOnUserInput: read a runtime thread status's active and waiting flags.
 * - threadLifecycleSignal: whether any sidebar thread needs attention, is working, or all are idle.
 */
import type { WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchProjectThreadRowSidebars } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { getQuestionnaireTitle } from "workbench-shared/workbench/thread/thread-questionnaire-transcript";

export function threadAttentionLabels(sidebars: WorkbenchProjectThreadRowSidebars, summaries: WorkbenchProjectThreadSummaries) {
  const labels: Record<string, string> = {};
  for (const project of summaries.projects) {
    for (const entry of project.pinnedThreads) {
      if (entry.entryKind === "thread" && (entry.canCompleteQuestionnaire || (entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput"))) {
        labels[entry.identity.threadId] = "Questionnaire";
      }
    }
  }
  for (const project of sidebars.projects) {
    for (const entry of project.entries) {
      if (entry.entryKind === "draft") continue;
      if (entry.pendingQuestionnaire) labels[entry.identity.threadId] = getQuestionnaireTitle(entry.pendingQuestionnaire.request);
      // Live approval prompts are not durable; their lifecycle still says the thread waits on input.
      else if (entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput") labels[entry.identity.threadId] = "Questionnaire";
    }
  }
  return labels;
}

export function isThreadStatusActive(status: string) {
  return status === "active" || status.startsWith("active:");
}

export function isThreadStatusWaitingOnUserInput(status: string) {
  if (!status.startsWith("active:")) return false;
  const [, activeFlags = ""] = status.split(":", 2);
  return activeFlags.split(",").includes("waitingOnUserInput");
}

export function threadLifecycleSignal(sidebars: WorkbenchProjectThreadRowSidebars) {
  const entries = sidebars.projects.flatMap(({ entries: projectEntries }) => projectEntries);
  if (entries.some(entry => entry.entryKind !== "draft" && entry.lifecycle.kind === "needsAttention")) return "needsAttention" as const;
  if (entries.some(entry => entry.entryKind !== "draft" && entry.lifecycle.kind === "working")) return "working" as const;
  return "idle" as const;
}
