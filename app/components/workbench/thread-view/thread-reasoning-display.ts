/*
 * Exports:
 * - ThreadReasoningStepReference: identify one visible reasoning section without hiding its sibling steps. Keywords: reasoning, section, identity.
 * - ThreadReasoningStep: renderer-ready reasoning title, description, Markdown, and source identity. Keywords: reasoning, display, title, description.
 * - getThreadReasoningSteps: project reasoning items into ordered visible steps. Keywords: reasoning, projection, order.
 * - getCurrentThreadReasoningActivity: select the newest live reasoning step after pending steers. Keywords: reasoning, live, status.
 * - omitThreadReasoningStep: remove one exact live step while preserving earlier disclosure content. Keywords: reasoning, disclosure, filter.
 */
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { isWorkbenchPendingSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

export interface ThreadReasoningStepReference {
  itemId: string;
  sectionIndex: number;
  source: "content" | "summary";
}

export interface ThreadReasoningStep extends ThreadReasoningStepReference {
  body: string | null;
  markdown: string;
  title: string;
}

function cleanReasoningTitleLine(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/u, "")
    .replace(/^\*\*(.+)\*\*$/u, "$1")
    .replace(/^\[(.+)\]$/u, "$1")
    .replace(/:$/u, "")
    .trim() || null;
}

function reasoningSectionBody(value: string) {
  const lines = value.split(/\r?\n/u);
  const titleIndex = lines.findIndex((line) => line.trim());
  if (titleIndex >= 0) lines.splice(titleIndex, 1);
  return lines.join("\n").trim() || null;
}

function visibleReasoningSections(item: ReasoningItem) {
  return item.summary.length
    ? { sections: item.summary, source: "summary" as const }
    : { sections: item.content, source: "content" as const };
}

export function getThreadReasoningSteps(items: readonly ReasoningItem[]): ThreadReasoningStep[] {
  return items.flatMap((item) => {
    const { sections, source } = visibleReasoningSections(item);
    return sections.flatMap((section, sectionIndex) => {
      const markdown = section.trim();
      if (!markdown) return [];
      return [{
        body: reasoningSectionBody(markdown),
        itemId: item.id,
        markdown,
        sectionIndex,
        source,
        title: cleanReasoningTitleLine(markdown) ?? "Step",
      }];
    });
  });
}

export function getCurrentThreadReasoningActivity(turn: Turn | null) {
  if (!turn || turn.status !== "inProgress") return null;

  let latestActivityItemIndex = turn.items.length - 1;
  while (
    latestActivityItemIndex >= 0
    && isWorkbenchPendingSteerUserMessage(turn.items[latestActivityItemIndex]!)
  ) {
    latestActivityItemIndex -= 1;
  }

  const latestItem = turn.items[latestActivityItemIndex];
  if (!latestItem || latestItem.type !== "reasoning") return null;
  const latestStep = getThreadReasoningSteps([latestItem]).at(-1);
  return latestStep
    ? {
      body: latestStep.body,
      hiddenStep: {
        itemId: latestStep.itemId,
        sectionIndex: latestStep.sectionIndex,
        source: latestStep.source,
      } satisfies ThreadReasoningStepReference,
      title: latestStep.title,
    }
    : { body: null, hiddenStep: null, title: "Thinking" };
}

export function omitThreadReasoningStep(
  item: ReasoningItem,
  hiddenStep: ThreadReasoningStepReference | null | undefined,
): ReasoningItem | null {
  if (!hiddenStep || hiddenStep.itemId !== item.id) return item;
  const { sections, source } = visibleReasoningSections(item);
  if (hiddenStep.source !== source || hiddenStep.sectionIndex < 0 || hiddenStep.sectionIndex >= sections.length) {
    return item;
  }
  const visibleSections = sections.filter((_section, index) => index !== hiddenStep.sectionIndex);
  if (!visibleSections.some((section) => section.trim())) return null;
  return source === "summary"
    ? { ...item, summary: visibleSections }
    : { ...item, content: visibleSections };
}
