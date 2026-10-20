/*
 * Exports:
 * - threadAttentionLabels/threadAttentionLabel: questionnaire labels from sidebar rows, for every thread or one.
 * - isThreadStatusActive/isThreadStatusWaitingOnUserInput: read a runtime thread status's active and waiting flags.
 */
import type { WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchProjectThreadRowSidebars } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { getQuestionnaireTitle } from "workbench-shared/workbench/thread/thread-questionnaire-transcript";

/** Visit every labelled sidebar thread. */
function visitAttention(sidebars: WorkbenchProjectThreadRowSidebars, visit: (threadId: string, label: string) => void) {
  for (const project of sidebars.projects) {
    for (const entry of project.entries) {
      if (entry.entryKind === "draft") continue;
      if (entry.pendingQuestionnaire) visit(entry.identity.threadId, getQuestionnaireTitle(entry.pendingQuestionnaire.request));
      // Live approval prompts are not durable; their lifecycle still says the thread waits on input.
      else if (entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput") visit(entry.identity.threadId, "Questionnaire");
    }
  }
}

export function threadAttentionLabels(sidebars: WorkbenchProjectThreadRowSidebars) {
  const labels: Record<string, string> = {};
  visitAttention(sidebars, (threadId, label) => { labels[threadId] = label; });
  return labels;
}

/** `_summaries` is unread: pinned summary rows now live only in the app, and this client copy is always empty. */
export function threadAttentionLabel(
  sidebars: WorkbenchProjectThreadRowSidebars, _summaries: WorkbenchProjectThreadSummaries, threadId: string,
) {
  let found = "";
  visitAttention(sidebars, (candidate, label) => { if (candidate === threadId) found = label; });
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
