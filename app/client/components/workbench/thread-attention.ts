/*
 * Exports:
 * - threadAttentionLabels/threadAttentionLabel: questionnaire labels from pinned summaries and sidebar rows, for every thread or one.
 * - isThreadStatusActive/isThreadStatusWaitingOnUserInput: read a runtime thread status's active and waiting flags.
 * - threadLifecycleSignal: whether any sidebar thread needs attention, is working, or all are idle.
 */
import type { WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchProjectThreadRowSidebars } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { getQuestionnaireTitle } from "workbench-shared/workbench/thread/thread-questionnaire-transcript";

/** Visit every labelled thread; sidebar rows win over pinned summary hints for the same thread. */
function visitAttention(sidebars: WorkbenchProjectThreadRowSidebars, summaries: WorkbenchProjectThreadSummaries,
  visit: (threadId: string, label: string) => void) {
  for (const project of summaries.projects) {
    for (const entry of project.pinnedThreads) {
      if (entry.entryKind === "thread" && (entry.canCompleteQuestionnaire || (entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput"))) {
        visit(entry.identity.threadId, "Questionnaire");
      }
    }
  }
  for (const project of sidebars.projects) {
    for (const entry of project.entries) {
      if (entry.entryKind === "draft") continue;
      if (entry.pendingQuestionnaire) visit(entry.identity.threadId, getQuestionnaireTitle(entry.pendingQuestionnaire.request));
      // Live approval prompts are not durable; their lifecycle still says the thread waits on input.
      else if (entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput") visit(entry.identity.threadId, "Questionnaire");
    }
  }
}

export function threadAttentionLabels(sidebars: WorkbenchProjectThreadRowSidebars, summaries: WorkbenchProjectThreadSummaries) {
  const labels: Record<string, string> = {};
  visitAttention(sidebars, summaries, (threadId, label) => { labels[threadId] = label; });
  return labels;
}

export function threadAttentionLabel(
  sidebars: WorkbenchProjectThreadRowSidebars, summaries: WorkbenchProjectThreadSummaries, threadId: string,
) {
  let found = "";
  visitAttention(sidebars, summaries, (candidate, label) => { if (candidate === threadId) found = label; });
  return found;
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
