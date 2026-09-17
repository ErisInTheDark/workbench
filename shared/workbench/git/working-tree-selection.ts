/*
 * Exports:
 * - WorkingTreeDiffRow: stable selectable row and presentation pairing.
 * - describeWorkingTreeDiff: derive unified rows, chunks and split pairing from one patch.
 * - buildSelectedContent: apply only selected change rows to a verified base.
 */
import { parseUnifiedDiff, type UnifiedDiffLine } from "../thread/unified-diff";

export interface WorkingTreeDiffRow extends UnifiedDiffLine {
  id: string;
  hunk: number;
  chunk: string | null;
  selectable: boolean;
  pairId: string | null;
  whitespaceOnly: boolean;
  noNewline: boolean;
}

export function describeWorkingTreeDiff(patch: string) {
  const parsed = parseUnifiedDiff(patch);
  const rows: WorkingTreeDiffRow[] = [];
  parsed.hunks.forEach((hunk, hunkIndex) => {
    let chunkIndex = 0;
    let changes: WorkingTreeDiffRow[] = [];
    const finishChunk = () => {
      const removed = changes.filter(row => row.type === "deletion");
      const added = changes.filter(row => row.type === "addition");
      removed.forEach((row, index) => {
        const other = added[index];
        if (!other) return;
        row.pairId = other.id;
        other.pairId = row.id;
        const whitespaceOnly = row.text.replace(/\s/gu, "") === other.text.replace(/\s/gu, "");
        row.whitespaceOnly = other.whitespaceOnly = whitespaceOnly;
      });
      changes = [];
      chunkIndex++;
    };
    hunk.lines.forEach((line, index) => {
      if (line.type === "note") {
        if (line.text.startsWith("\\ No newline") && rows.at(-1)) rows.at(-1)!.noNewline = true;
        return;
      }
      const selectable = line.type === "addition" || line.type === "deletion";
      if (!selectable && changes.length) finishChunk();
      const row: WorkingTreeDiffRow = {
        ...line, id: `${hunkIndex}:${index}`, hunk: hunkIndex,
        chunk: selectable ? `${hunkIndex}:${chunkIndex}` : null,
        selectable, pairId: null, whitespaceOnly: false, noNewline: false,
      };
      rows.push(row);
      if (selectable) changes.push(row);
    });
    finishChunk();
  });
  return { rows, hunks: parsed.hunks, complete: parsed.hunks.length > 0 && parsed.hunks.every(hunk => hunk.complete) };
}

export function buildSelectedContent(base: string, patch: string, selectedIds: readonly string[], after: string) {
  const model = describeWorkingTreeDiff(patch);
  if (!model.complete) throw new Error("Incomplete diff cannot be partially selected.");
  const selected = new Set(selectedIds);
  const valid = new Set(model.rows.filter(row => row.selectable).map(row => row.id));
  if ([...selected].some(id => !valid.has(id))) throw new Error("The line selection is no longer valid.");
  const lines = base.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const afterLines = after.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const output: string[] = [];
  let cursor = 0;
  model.hunks.forEach((hunk, index) => {
    const start = hunk.oldCount === 0 ? hunk.oldStart! : Math.max(0, hunk.oldStart! - 1);
    if (start < cursor || start > lines.length) throw new Error("Diff base ranges do not match.");
    for (const line of lines.slice(cursor, start)) output.push(line);
    cursor = start;
    for (const row of model.rows.filter(row => row.hunk === index)) {
      if (row.type === "addition") {
        const line = afterLines[row.newLineNumber! - 1];
        if (line === undefined || line.replace(/\r?\n$/u, "") !== row.text
          || row.noNewline !== !line.endsWith("\n")) throw new Error("Diff selected content does not match.");
        if (selected.has(row.id)) output.push(line);
      } else {
        const line = lines[cursor++];
        if (line === undefined || line.replace(/\r?\n$/u, "") !== row.text
          || row.noNewline !== !line.endsWith("\n")) throw new Error("Diff base content does not match.");
        if (row.type === "context" || !selected.has(row.id)) output.push(line);
      }
    }
  });
  for (const line of lines.slice(cursor)) output.push(line);
  return output.join("");
}
