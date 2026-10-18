/*
 * Exports:
 * - InputListRow: stable identity plus key and value text; single-input lists leave key empty. Lists may carry optional
 *   extra fields per row, which edits, moves and history keep.
 * - InputListHistory: undoable row snapshots with typing grouped per field.
 * - InputListRows: pure row edits that keep exactly one trailing blank row (none once a limited list is full), reordering,
 *   plus undo/redo history.
 */
type NoExtra = Record<never, never>;

export type InputListRow<Extra extends object = NoExtra> = { id: string; key: string; value: string } & Partial<Extra>;

export interface InputListHistory<Extra extends object = NoExtra> {
  past: readonly (readonly InputListRow<Extra>[])[];
  future: readonly (readonly InputListRow<Extra>[])[];
  group: string | null;
}

const HISTORY_LIMIT = 200;

function blank<Extra extends object>(): InputListRow<Extra> {
  return { id: crypto.randomUUID(), key: "", value: "" } as InputListRow<Extra>;
}

function isBlank(row: InputListRow<object>) {
  return !row.key.trim() && !row.value.trim();
}

/** A full list offers no blank row to type a new entry into. */
function withTrailingBlank<Extra extends object>(rows: InputListRow<Extra>[], limit: number) {
  const filled = rows.filter(row => !isBlank(row)).length;
  if (filled >= limit) return rows.filter(row => !isBlank(row));
  return rows.length && isBlank(rows.at(-1)!) ? rows : [...rows, blank<Extra>()];
}

export const InputListRows = {
  create<Extra extends object = NoExtra>(
    entries: readonly ({ id?: string; key?: string; value: string } & Partial<Extra>)[],
    limit = Infinity,
  ): InputListRow<Extra>[] {
    return withTrailingBlank(entries.map(entry => ({ ...entry, id: entry.id ?? crypto.randomUUID(), key: entry.key ?? "" }) as InputListRow<Extra>)
      .filter(row => !isBlank(row)), limit);
  },

  edit<Extra extends object>(
    rows: readonly InputListRow<Extra>[],
    id: string,
    patch: Partial<Omit<InputListRow<Extra>, "id">>,
    limit = Infinity,
  ): InputListRow<Extra>[] {
    return withTrailingBlank(rows.map(row => row.id === id ? { ...row, ...patch } : row), limit);
  },

  remove<Extra extends object>(rows: readonly InputListRow<Extra>[], id: string, limit = Infinity): InputListRow<Extra>[] {
    return withTrailingBlank(rows.filter(row => row.id !== id), limit);
  },

  /** Move a filled row to an index among the filled rows; the trailing blank stays last. */
  move<Extra extends object>(rows: readonly InputListRow<Extra>[], id: string, index: number, limit = Infinity): InputListRow<Extra>[] {
    const filled = rows.filter(row => !isBlank(row));
    const from = filled.findIndex(row => row.id === id);
    if (from < 0) return [...rows];
    const to = Math.max(0, Math.min(filled.length - 1, index));
    if (to === from) return [...rows];
    const next = filled.filter(row => row.id !== id);
    next.splice(to, 0, filled[from]!);
    return withTrailingBlank([...next, ...rows.filter(isBlank)], limit);
  },

  /** Drops empty rows that are not last, keeping the final blank. */
  settle<Extra extends object>(rows: readonly InputListRow<Extra>[], limit = Infinity): InputListRow<Extra>[] {
    const filled = rows.filter(row => !isBlank(row));
    const lastBlank = rows.findLast(isBlank);
    return withTrailingBlank([...filled, lastBlank ?? blank<Extra>()], limit);
  },

  populated<Extra extends object>(rows: readonly InputListRow<Extra>[]) {
    return rows.filter(row => !isBlank(row));
  },

  isBlank,

  history: {
    empty<Extra extends object = NoExtra>(): InputListHistory<Extra> {
      return { past: [], future: [], group: null };
    },

    /** Records `previous` before a change; consecutive changes in one group collapse into one undo step. */
    record<Extra extends object>(
      history: InputListHistory<Extra>,
      previous: readonly InputListRow<Extra>[],
      group: string | null,
    ): InputListHistory<Extra> {
      if (group !== null && group === history.group) return { ...history, future: [] };
      return { past: [...history.past, previous].slice(-HISTORY_LIMIT), future: [], group };
    },

    undo<Extra extends object>(history: InputListHistory<Extra>, current: readonly InputListRow<Extra>[]) {
      const previous = history.past.at(-1);
      if (!previous) return null;
      return { rows: previous, history: { past: history.past.slice(0, -1), future: [current, ...history.future], group: null } };
    },

    redo<Extra extends object>(history: InputListHistory<Extra>, current: readonly InputListRow<Extra>[]) {
      const [next, ...future] = history.future;
      if (!next) return null;
      return { rows: next, history: { past: [...history.past, current], future, group: null } };
    },
  },
};
