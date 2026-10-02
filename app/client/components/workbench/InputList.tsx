/*
 * Exports:
 * - default InputList: edit a list of single inputs or key/value pairs, owning the trailing blank row, empty-row cleanup and undo/redo.
 */
"use client";

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { InputListRows, type InputListHistory, type InputListRow } from "./input-list-rows";
import { XIcon } from "./workbench-icons";

const fieldClassName = "w-full min-w-0 bg-transparent py-2 pl-3 text-[0.85rem] text-text outline-none";

export default function InputList({
  disabled,
  errors,
  idPrefix,
  keyPlaceholder,
  kind = "single",
  onRowsChange,
  placeholder,
  rowLabel,
  rows,
}: {
  disabled?: boolean;
  errors?: Readonly<Record<string, string | undefined>>;
  idPrefix: string;
  /** Placeholder for the key input in `pairs` mode. */
  keyPlaceholder?: string;
  kind?: "single" | "pairs";
  /** Receives every row change, including cleanup after focus leaves the list. Pass the array back unchanged to keep undo history. */
  onRowsChange: (rows: InputListRow[]) => void;
  /** Placeholder for the value input. */
  placeholder?: string;
  rowLabel: string;
  rows: readonly InputListRow[];
}) {
  const fieldRefs = useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>());
  const pendingFocusIndex = useRef<number | null>(null);
  const history = useRef<InputListHistory>(InputListRows.history.empty());
  const emitted = useRef<readonly InputListRow[] | null>(null);
  // Rows the list did not emit came from a load or reset, which starts a fresh history.
  if (rows !== emitted.current) {
    history.current = InputListRows.history.empty();
    emitted.current = rows;
  }

  useLayoutEffect(() => {
    for (const field of fieldRefs.current.values()) {
      if (!(field instanceof HTMLTextAreaElement)) continue;
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }
  }, [rows]);

  useLayoutEffect(() => {
    const index = pendingFocusIndex.current;
    if (index === null) return;
    pendingFocusIndex.current = null;
    const row = rows[Math.min(index, rows.length - 1)];
    const field = row ? fieldRefs.current.get(`${row.id}:${kind === "pairs" ? "key" : "value"}`) : null;
    field?.focus();
    field?.select();
  }, [kind, rows]);

  function emit(next: InputListRow[], group: string | null) {
    if (next === rows) return;
    history.current = InputListRows.history.record(history.current, rows, group);
    emitted.current = next;
    onRowsChange(next);
  }

  function travel(direction: "undo" | "redo") {
    const step = InputListRows.history[direction](history.current, rows);
    if (!step) return;
    const next = [...step.rows];
    history.current = step.history;
    emitted.current = next;
    onRowsChange(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const direction = key === "z" ? event.shiftKey ? "redo" : "undo" : key === "y" && !event.shiftKey ? "redo" : null;
    if (!direction) return;
    event.preventDefault();
    travel(direction);
  }

  function bind(row: InputListRow, field: "key" | "value") {
    return (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (node) fieldRefs.current.set(`${row.id}:${field}`, node);
      else fieldRefs.current.delete(`${row.id}:${field}`);
    };
  }

  return (
    <div
      className="divide-y divide-text/16 overflow-hidden rounded-[0.8rem] border border-text/16 bg-text/[0.03]"
      onKeyDown={handleKeyDown}
      onBlur={event => {
        if (pendingFocusIndex.current === null && !event.currentTarget.contains(event.relatedTarget)) {
          const settled = InputListRows.settle(rows);
          if (settled.length !== rows.length) emit(settled, null);
        }
      }}
    >
      {rows.map((row, index) => {
        const label = `${rowLabel} ${index + 1}`;
        const inputId = `${idPrefix}-${row.id}`;
        const error = errors?.[row.id];
        const errorId = `${inputId}-issue`;
        const shared = {
          "aria-invalid": Boolean(error),
          "aria-describedby": error ? errorId : undefined,
          autoComplete: "off",
          disabled,
          spellCheck: false,
        };
        return (
          <div key={row.id} className="relative focus-within:bg-text/[0.07]">
            {kind === "pairs" ? (
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] sm:divide-x divide-text/10 pr-9">
                <input
                  {...shared}
                  ref={bind(row, "key")}
                  id={`${inputId}-key`}
                  aria-label={`${label} key`}
                  className={`${fieldClassName} pr-3 font-mono`}
                  onChange={event => emit(InputListRows.edit(rows, row.id, { key: event.target.value }), `${row.id}:key`)}
                  placeholder={keyPlaceholder}
                  type="text"
                  value={row.key}
                />
                <textarea
                  {...shared}
                  ref={bind(row, "value")}
                  id={inputId}
                  aria-label={`${label} value`}
                  className={`${fieldClassName} resize-none overflow-hidden whitespace-pre-wrap break-words pr-3 font-mono`}
                  onChange={event => emit(InputListRows.edit(rows, row.id, { value: event.target.value }), `${row.id}:value`)}
                  placeholder={placeholder}
                  rows={1}
                  value={row.value}
                />
              </div>
            ) : (
              <input
                {...shared}
                ref={bind(row, "value")}
                id={inputId}
                aria-label={label}
                className={`${fieldClassName} pr-10`}
                onChange={event => emit(InputListRows.edit(rows, row.id, { value: event.target.value }), `${row.id}:value`)}
                placeholder={placeholder}
                type="text"
                value={row.value}
              />
            )}
            {index === rows.length - 1 && !row.key.trim() && !row.value.trim() ? null : (
              <button
                aria-label={`Remove ${label}`}
                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md bg-transparent text-fg/muted outline-none hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                disabled={disabled}
                onClick={() => {
                  pendingFocusIndex.current = index;
                  emit(InputListRows.remove(rows, row.id), null);
                }}
                type="button"
              >
                <XIcon size={14} />
              </button>
            )}
            {error ? <p id={errorId} role="alert" className="m-0 px-3 pb-2 text-[0.76rem] text-danger">{error}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
