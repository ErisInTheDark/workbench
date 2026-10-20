/*
 * Exports:
 * - UserMessageBubbleLayout: leading composer references plus the bubbles one user message shows.
 * - layoutUserMessageBubbles: split leading references off one user message, then split the rest into bubbles at `=====` separator lines.
 */
import { readComposerReferenceMessage, type ComposerReference } from "workbench-shared/workbench/thread/composer-reference";
import type { WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";

export interface UserMessageBubbleLayout {
  /** Shown as pills leading the first bubble. */
  references: ComposerReference[];
  /** Never empty while references exist, so reference-only messages still get a bubble to carry pills and actions. */
  bubbles: UserInput[][];
}

/** A line of five or more `=` and nothing else. */
const SEPARATOR = /^[ \t]*={5,}[ \t]*$/mu;

/** References lead a message's first text part; the rest of that part is the user's own words. */
function splitLeadingComposerReferences(content: readonly UserInput[]): { content: UserInput[]; references: ComposerReference[] } {
  const [first, ...rest] = content;
  const read = first?.type === "text" ? readComposerReferenceMessage(first.text) : null;
  if (!first || first.type !== "text" || !read) return { content: [...content], references: [] };
  return {
    content: read.message ? [{ ...first, text: read.message, text_elements: [] }, ...rest] : rest,
    references: read.references,
  };
}

/** Images stay with the text they follow; empty segments vanish. */
function splitBubbles(input: readonly UserInput[]): UserInput[][] {
  const bubbles: UserInput[][] = [[]];
  for (const item of input) {
    if (item.type !== "text") {
      bubbles.at(-1)!.push(item);
      continue;
    }
    item.text.split(SEPARATOR).forEach((segment, index) => {
      if (index > 0) bubbles.push([]);
      if (segment.trim()) bubbles.at(-1)!.push({ ...item, text: segment.trim() });
    });
  }
  return bubbles.filter((bubble) => bubble.length);
}

export function layoutUserMessageBubbles(input: readonly UserInput[]): UserMessageBubbleLayout {
  const { content, references } = splitLeadingComposerReferences(input);
  const bubbles = splitBubbles(content);
  return { references, bubbles: bubbles.length || !references.length ? bubbles : [[]] };
}
