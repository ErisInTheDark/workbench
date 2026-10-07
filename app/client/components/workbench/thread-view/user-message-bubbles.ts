/*
 * Exports:
 * - splitUserMessageBubbles: split one user message into the separate bubbles its `=====` separator lines mark.
 */
import type { WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";

/** A line of five or more `=` and nothing else. */
const SEPARATOR = /^[ \t]*={5,}[ \t]*$/mu;

/** Images stay with the text they follow; empty segments vanish. */
export function splitUserMessageBubbles(input: readonly UserInput[]): UserInput[][] {
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
