/*
 * Exports:
 * - InputListRow: stable identity plus key and value text; single-input lists leave key empty.
 * - InputListHistory: undoable row snapshots with typing grouped per field.
 * - InputListRows: pure row edits that keep exactly one trailing blank row, plus undo/redo history.
 */
export interface InputListRow {
  id: string;
  key: string;
  value: string;
}

export interface InputListHistory {
  past: readonly (readonly InputListRow[])[];
  future: readonly (readonly InputListRow[])[];
  group: string | null;
}

const HISTORY_LIMIT = 200;

function blank(): InputListRow {
  return { id: crypto.randomUUID(), key: "", value: "" };
}

function isBlank(row: InputListRow) {
  return !row.key.trim() && !row.value.trim();
}

function withTrailingBlank(rows: InputListRow[]) {
  return rows.length && isBlank(rows.at(-1)!) ? rows : [...rows, blank()];
}

export const InputListRows = {
  create(entries: readonly { id?: string; key?: string; value: string }[]): InputListRow[] {
    return withTrailingBlank(entries.map(entry => ({ id: entry.id ?? crypto.randomUUID(), key: entry.key ?? "", value: entry.value }))
      .filter(row => !isBlank(row)));
  },

  edit(rows: readonly InputListRow[], id: string, patch: Partial<Pick<InputListRow, "key" | "value">>): InputListRow[] {
    return withTrailingBlank(rows.map(row => row.id === id ? { ...row, ...patch } : row));
  },

  remove(rows: readonly InputListRow[], id: string): InputListRow[] {
    return withTrailingBlank(rows.filter(row => row.id !== id));
  },

  /** Drops empty rows that are not last, keeping the final blank. */
  settle(rows: readonly InputListRow[]): InputListRow[] {
    const filled = rows.filter(row => !isBlank(row));
    const lastBlank = rows.findLast(isBlank);
    return [...filled, lastBlank ?? blank()];
  },

  populated(rows: readonly InputListRow[]) {
    return rows.filter(row => !isBlank(row));
  },

  history: {
    empty(): InputListHistory {
      return { past: [], future: [], group: null };
    },

    /** Records `previous` before a change; consecutive changes in one group collapse into one undo step. */
    record(history: InputListHistory, previous: readonly InputListRow[], group: string | null): InputListHistory {
      if (group !== null && group === history.group) return { ...history, future: [] };
      return { past: [...history.past, previous].slice(-HISTORY_LIMIT), future: [], group };
    },

    undo(history: InputListHistory, current: readonly InputListRow[]) {
      const previous = history.past.at(-1);
      if (!previous) return null;
      return { rows: previous, history: { past: history.past.slice(0, -1), future: [current, ...history.future], group: null } };
    },

    redo(history: InputListHistory, current: readonly InputListRow[]) {
      const [next, ...future] = history.future;
      if (!next) return null;
      return { rows: next, history: { past: [...history.past, current], future, group: null } };
    },
  },
};
