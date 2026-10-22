/*
 * Exports:
 * - buildMarkdownDiff: a markdown file's new text with its edits marked in place as `<ins>`/`<del>` review markup, so
 *   the ordinary markdown renderer shows what changed where it reads. Edited lines mark their changed words, removed
 *   lines appear struck where they were, and wholly new lines read as written.
 */
import type { WorkingTreeDiffModel, WorkingTreeDiffRow } from "workbench-shared/workbench/git/working-tree-selection";

const BLOCK_PREFIX = /^(\s{0,3}#{1,6}\s+|\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|\s*>\s?)/u;
const FENCE = /^\s{0,3}(```|~~~)/u;

/** Headings, list markers and quotes stay outside marks so the line keeps its block shape. */
function prefixLength(text: string) {
  return BLOCK_PREFIX.exec(text)?.[0].length ?? 0;
}

function mark(tag: "ins" | "del", text: string) {
  return text.trim() ? `<${tag}>${text}</${tag}>` : text;
}

/** The changed middle of a line against its old version, kept clear of the block prefix. */
function changedSpan(before: string, after: string) {
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (start < shortest && before[start] === after[start]) start++;
  start = Math.min(Math.max(start, prefixLength(after)), shortest);
  let end = 0;
  while (end < shortest - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return { start, afterEnd: after.length - end, beforeEnd: before.length - end };
}

export function buildMarkdownDiff(after: string, model: WorkingTreeDiffModel) {
  const lines = after.split("\n");
  const byId = new Map(model.rows.map(row => [row.id, row]));
  /** Whole old lines shown just above a new line, by its 1-based number. */
  const removedBefore = new Map<number, string[]>();
  const rewritten = new Map<number, string>();
  const rows = model.rows;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.type === "addition" && row.newLineNumber) {
      const pair = row.pairId ? byId.get(row.pairId) : undefined;
      const text = lines[row.newLineNumber - 1] ?? row.text;
      const beforePrefix = pair ? prefixLength(pair.text) : 0;
      const afterPrefix = prefixLength(text);
      if (pair && pair.text.slice(0, beforePrefix) !== text.slice(0, afterPrefix)) {
        // A line that changed its block kind (a paragraph becoming a list item) shows as wholly replaced.
        rewritten.set(row.newLineNumber, `${text.slice(0, afterPrefix)}${mark("del", pair.text.slice(beforePrefix))}${mark("ins", text.slice(afterPrefix))}`);
      } else if (pair) {
        const { start, afterEnd, beforeEnd } = changedSpan(pair.text, text);
        rewritten.set(row.newLineNumber, `${text.slice(0, start)}${mark("del", pair.text.slice(start, beforeEnd))}${mark("ins", text.slice(start, afterEnd))}${text.slice(afterEnd)}`);
      }
      // A wholly new line reads as written, like gitman: marking it would tint whole documents and break block syntax
      // such as setext underlines.
    } else if (row.type === "deletion" && !row.pairId) {
      const anchor = rows.slice(index + 1).find((next: WorkingTreeDiffRow) => next.hunk === row.hunk && next.newLineNumber)?.newLineNumber
        ?? rows.slice(0, index).reverse().find((previous: WorkingTreeDiffRow) => previous.hunk === row.hunk && previous.newLineNumber)?.newLineNumber
        ?? 1;
      const prefix = prefixLength(row.text);
      const list = removedBefore.get(anchor) ?? [];
      list.push(`${row.text.slice(0, prefix)}${mark("del", row.text.slice(prefix))}`);
      removedBefore.set(anchor, list);
    }
  }
  let fenced = false;
  const output: string[] = [];
  lines.forEach((line, index) => {
    const number = index + 1;
    const opensOrCloses = FENCE.test(line);
    // Inside a code fence markup would read literally, so changed code shows unmarked.
    if (!fenced) for (const removed of removedBefore.get(number) ?? []) output.push(removed);
    output.push(fenced || opensOrCloses ? line : rewritten.get(number) ?? line);
    if (opensOrCloses) fenced = !fenced;
  });
  const tail = removedBefore.get(lines.length + 1);
  if (tail) output.push(...tail);
  return output.join("\n");
}
