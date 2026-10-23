/*
 * Exports:
 * - isTranscriptRunItemType: whether a stored item type folds into a run of agent work rather than standing as its own row.
 * - countTranscriptRows: how many visible rows an ordered item list shows.
 * - selectNewestTranscriptRows: the index where the newest `rowCredit` visible rows of an ordered item list begin.
 */

/**
 * Agent work the browser folds into run cards. The browser's own grouping is finer (some commands end a run), so this
 * only ever merges more than it does: a window counted here shows at least as many rows as it was asked for.
 */
const RUN_ITEM_TYPES: ReadonlySet<string> = new Set(["reasoning", "operation", "fileChange", "webSearch", "functionCallOutput"]);

export function isTranscriptRunItemType(type: string) {
  return RUN_ITEM_TYPES.has(type);
}

/** Visible rows in `types` (stored item types, oldest first). */
export function countTranscriptRows(types: readonly string[]) {
  let rows = 0;
  for (let index = 0; index < types.length; index += 1) {
    if (!isTranscriptRunItemType(types[index]!) || index === 0 || !isTranscriptRunItemType(types[index - 1]!)) rows += 1;
  }
  return rows;
}

/**
 * `types` are stored item types, oldest first. A standalone item is one row; a back-to-back stretch of run items is one
 * row however long. Returns the first index inside the newest `rowCredit` rows, so a window can start inside a stretch
 * only by taking all of its newer items.
 */
export function selectNewestTranscriptRows(types: readonly string[], rowCredit: number) {
  let rows = 0;
  for (let index = types.length - 1; index >= 0; index -= 1) {
    const run = isTranscriptRunItemType(types[index]!);
    const continuesRow = run && index < types.length - 1 && isTranscriptRunItemType(types[index + 1]!);
    if (!continuesRow) {
      if (rows === rowCredit) return index + 1;
      rows += 1;
    }
  }
  return 0;
}
