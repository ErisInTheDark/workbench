/*
 * Exports:
 * - ThreadCommentaryRunActions: where one commentary item ends prose runs, with each run's copy Markdown.
 * - buildThreadCommentaryRuns: merge consecutive commentary prose into runs split by plans and mode changes.
 */
import { parseThreadMarkdownSections } from "../../../workbench/markdown/markdown-parse";

export interface ThreadCommentaryRunActions {
  /** Copy Markdown of the run ending right before each of the item's section breaks, in break order. */
  breakCopyMarkdown: Array<string | null>;
  /** Copy Markdown of the run ending at the item's end. */
  endCopyMarkdown: string | null;
}

export function buildThreadCommentaryRuns(texts: readonly string[]): ThreadCommentaryRunActions[] {
  const runs = texts.map((): ThreadCommentaryRunActions => ({ breakCopyMarkdown: [], endCopyMarkdown: null }));
  let pending: string[] = [];
  let lastProseItemIndex = -1;
  const closeRun = (itemIndex: number) => {
    if (!pending.length) return null;
    const markdown = pending.join("\n\n");
    pending = [];
    if (lastProseItemIndex === itemIndex) return markdown;
    runs[lastProseItemIndex]!.endCopyMarkdown = markdown;
    return null;
  };
  texts.forEach((text, itemIndex) => {
    for (const section of parseThreadMarkdownSections(text)) {
      if (section.kind === "prose") {
        pending.push(section.markdown);
        lastProseItemIndex = itemIndex;
      } else {
        runs[itemIndex]!.breakCopyMarkdown.push(closeRun(itemIndex));
      }
    }
  });
  closeRun(-1);
  return runs;
}
