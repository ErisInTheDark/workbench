/*
 * Exports:
 * - default InputList: edit a list of single inputs or key/value pairs, owning the trailing blank row, empty-row cleanup and undo/redo;
 *   optionally a fixed row set, a row limit, drag and arrow-key reordering, leading and trailing row content, and secret values
 *   shown as dots until revealed.
 */
"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { InputListRows, type InputListHistory, type InputListRow } from "./input-list-rows";
import { EyeIcon, EyeOffIcon, GripVerticalIcon, XIcon } from "./workbench-icons";

const fieldClassName = "w-full min-w-0 bg-transparent py-2 pl-3 text-[0.85rem] text-text outline-none";
const rowButtonClassName = "flex size-7 items-center justify-center rounded-md bg-transparent text-fg/muted outline-none hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text";
/** Room the absolutely placed row buttons need at the end of a field, by button count. */
const buttonInsetClassNames = ["pr-3", "pr-10", "pr-[4.5rem]", "pr-[6.25rem]"] as const;

interface Drag {
  id: string;
  /** Where the dragged row would land among the filled rows. */
  target: number;
  from: number;
  offset: number;
  pointerId: number;
  /** Filled rows' vertical extents when the drag began. */
  slots: ReadonlyArray<{ bottom: number; top: number }>;
  startY: number;
}

export default function InputList<Extra extends object = Record<never, never>>({
  disabled,
  errors,
  fixedRows = false,
  idPrefix,
  keyPlaceholder,
  kind = "single",
  limit = Infinity,
  onRowsChange,
  placeholder,
  renderLeading,
  renderTrailing,
  reorderable = false,
  rowLabel,
  rowLabels,
  rows,
  secret = false,
}: {
  disabled?: boolean;
  errors?: Readonly<Record<string, string | undefined>>;
  /** Edit exactly the given rows: no trailing blank row, removal or empty-row cleanup. */
  fixedRows?: boolean;
  idPrefix: string;
  /** Placeholder for the key input in `pairs` mode. */
  keyPlaceholder?: string;
  kind?: "single" | "pairs";
  /** Most filled rows; a full list offers no blank row. */
  limit?: number;
  /** Receives every row change, including cleanup after focus leaves the list. Pass the array back unchanged to keep undo history. */
  onRowsChange: (rows: InputListRow<Extra>[]) => void;
  /** Placeholder for the value input. */
  placeholder?: string;
  /** Content before a row's drag handle and inputs, such as its position or shortcut. */
  renderLeading?: (row: InputListRow<Extra>, index: number) => ReactNode;
  /** One extra row button before the remove button; `edit` patches the row as one undo step. */
  renderTrailing?: (row: InputListRow<Extra>, edit: (patch: Partial<Omit<InputListRow<Extra>, "id">>) => void) => ReactNode;
  /** Filled rows get a handle that drags them, or moves them with the arrow keys. */
  reorderable?: boolean;
  rowLabel: string;
  /** Accessible labels by row id, replacing the numbered `rowLabel`. */
  rowLabels?: Readonly<Record<string, string>>;
  rows: readonly InputListRow<Extra>[];
  /** Show values as dots until each row is revealed (single inputs only). */
  secret?: boolean;
}) {
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const fieldRefs = useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>());
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocusIndex = useRef<number | null>(null);
  const history = useRef<InputListHistory<Extra>>(InputListRows.history.empty<Extra>());
  const emitted = useRef<readonly InputListRow<Extra>[] | null>(null);
  // Rows the list did not emit came from a load or reset, which starts a fresh history.
  if (rows !== emitted.current) {
    history.current = InputListRows.history.empty<Extra>();
    emitted.current = rows;
  }
  const filledIds = InputListRows.populated(rows).map(row => row.id);

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

  function emit(next: InputListRow<Extra>[], group: string | null) {
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

  function bind(row: InputListRow<Extra>, field: "key" | "value") {
    return (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (node) fieldRefs.current.set(`${row.id}:${field}`, node);
      else fieldRefs.current.delete(`${row.id}:${field}`);
    };
  }

  function move(id: string, index: number) {
    emit(InputListRows.move(rows, id, index, limit), null);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const slots = filledIds.map(rowId => {
      const rect = rowRefs.current.get(rowId)?.getBoundingClientRect();
      return { bottom: rect?.bottom ?? 0, top: rect?.top ?? 0 };
    });
    const from = filledIds.indexOf(id);
    setDrag({ from, id, offset: 0, pointerId: event.pointerId, slots, startY: event.clientY, target: from });
  }

  function continueDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const own = drag.slots[drag.from]!;
    const first = drag.slots[0]!;
    const last = drag.slots.at(-1)!;
    const offset = Math.max(first.top - own.top, Math.min(last.bottom - own.bottom, event.clientY - drag.startY));
    // A row is passed once the dragged row's leading edge crosses its middle, so dragging to either end always reaches it.
    const top = own.top + offset;
    const bottom = own.bottom + offset;
    const middle = (slot: { bottom: number; top: number }) => (slot.top + slot.bottom) / 2;
    const target = drag.from
      - drag.slots.filter((slot, index) => index < drag.from && top < middle(slot)).length
      + drag.slots.filter((slot, index) => index > drag.from && bottom > middle(slot)).length;
    setDrag({ ...drag, offset, target });
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setDrag(null);
    if (commit && drag.target !== drag.from) move(drag.id, drag.target);
  }

  /** While dragging, rows between the dragged row's start and target step aside by its height. */
  function dragStyle(id: string): CSSProperties | undefined {
    if (!drag) return undefined;
    if (id === drag.id) return { transform: `translateY(${drag.offset}px)` };
    const index = filledIds.indexOf(id);
    const own = drag.slots[drag.from]!;
    const height = own.bottom - own.top;
    if (index > drag.from && index <= drag.target) return { transform: `translateY(${-height}px)` };
    if (index < drag.from && index >= drag.target) return { transform: `translateY(${height}px)` };
    return undefined;
  }

  return (
    <div
      className="divide-y divide-text/16 overflow-hidden rounded-[0.8rem] border border-text/16 bg-text/[0.03]"
      onKeyDown={handleKeyDown}
      onBlur={event => {
        if (!fixedRows && pendingFocusIndex.current === null && !event.currentTarget.contains(event.relatedTarget)) {
          const settled = InputListRows.settle(rows, limit);
          if (settled.length !== rows.length) emit(settled, null);
        }
      }}
    >
      {rows.map((row, index) => {
        const label = rowLabels?.[row.id] ?? `${rowLabel} ${index + 1}`;
        const editRow = (patch: Partial<Omit<InputListRow<Extra>, "id">>) => fixedRows
          ? rows.map(candidate => candidate.id === row.id ? { ...candidate, ...patch } : candidate)
          : InputListRows.edit(rows, row.id, patch, limit);
        const masked = secret && kind === "single" && !revealed.has(row.id);
        const inputId = `${idPrefix}-${row.id}`;
        const error = errors?.[row.id];
        const errorId = `${inputId}-issue`;
        const filled = !InputListRows.isBlank(row);
        const showRemove = !fixedRows && !(index === rows.length - 1 && !filled);
        const trailing = renderTrailing?.(row, patch => emit(editRow(patch), null));
        const buttonCount = Number(secret && kind === "single" && Boolean(row.value)) + Number(Boolean(trailing)) + Number(showRemove);
        const dragging = drag?.id === row.id;
        const shared = {
          "aria-invalid": Boolean(error),
          "aria-describedby": error ? errorId : undefined,
          autoComplete: "off",
          disabled,
          spellCheck: false,
        };
        const leading = renderLeading || reorderable ? (
          <span className="flex shrink-0 items-center self-stretch pl-2">
            {renderLeading?.(row, index)}
            {reorderable ? (filled ? (
              <button
                aria-label={`Move ${label}`}
                title="Drag, or use the arrow keys, to reorder"
                className={`${rowButtonClassName} cursor-grab touch-none active:cursor-grabbing`}
                disabled={disabled}
                onKeyDown={event => {
                  const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                  if (!step) return;
                  event.preventDefault();
                  move(row.id, filledIds.indexOf(row.id) + step);
                }}
                onLostPointerCapture={event => finishDrag(event, true)}
                onPointerCancel={event => finishDrag(event, false)}
                onPointerDown={event => startDrag(event, row.id)}
                onPointerMove={continueDrag}
                type="button"
              >
                <GripVerticalIcon size={14} />
              </button>
            ) : <span aria-hidden="true" className="size-7" />) : null}
          </span>
        ) : null;
        return (
          <div
            key={row.id}
            ref={node => {
              if (node) rowRefs.current.set(row.id, node);
              else rowRefs.current.delete(row.id);
            }}
            className={`
              relative flex items-start focus-within:bg-text/[0.07]
              ${dragging ? "z-10 bg-[color-mix(in srgb, var(--app-bg-solid) 92%, var(--text) 8%)]" : ""}
              ${drag && !dragging ? "transition-transform duration-150 ease-out motion-reduce:transition-none" : ""}
            `}
            style={dragStyle(row.id)}
          >
            {leading}
            <div className="min-w-0 flex-1">
              {kind === "pairs" ? (
                <div className={`grid grid-cols-1 sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] sm:divide-x divide-text/10 ${buttonCount > 1 ? buttonInsetClassNames[buttonCount] : "pr-9"}`}>
                  <input
                    {...shared}
                    ref={bind(row, "key")}
                    id={`${inputId}-key`}
                    aria-label={`${label} key`}
                    className={`${fieldClassName} pr-3 font-mono`}
                    onChange={event => emit(editRow({ key: event.target.value } as Partial<Omit<InputListRow<Extra>, "id">>), `${row.id}:key`)}
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
                    onChange={event => emit(editRow({ value: event.target.value } as Partial<Omit<InputListRow<Extra>, "id">>), `${row.id}:value`)}
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
                  className={`
                    ${fieldClassName}
                    ${buttonInsetClassNames[Math.max(1, buttonCount)]}
                    ${secret ? "font-mono" : ""}
                  `}
                  onChange={event => emit(editRow({ value: event.target.value } as Partial<Omit<InputListRow<Extra>, "id">>), `${row.id}:value`)}
                  placeholder={placeholder}
                  type={masked ? "password" : "text"}
                  value={row.value}
                />
              )}
              {error ? <p id={errorId} role="alert" className="m-0 px-3 pb-2 text-[0.76rem] text-danger">{error}</p> : null}
            </div>
            <span className="absolute right-1 top-1 flex items-center">
              {secret && kind === "single" && row.value ? (
                <button
                  aria-label={masked ? `Show ${label}` : `Hide ${label}`}
                  aria-pressed={!masked}
                  className={rowButtonClassName}
                  disabled={disabled}
                  onClick={() => setRevealed(current => {
                    const next = new Set(current);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  })}
                  type="button"
                >
                  {masked ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
                </button>
              ) : null}
              {trailing}
              {showRemove ? (
                <button
                  aria-label={`Remove ${label}`}
                  className={rowButtonClassName}
                  disabled={disabled}
                  onClick={() => {
                    pendingFocusIndex.current = index;
                    emit(InputListRows.remove(rows, row.id, limit), null);
                  }}
                  type="button"
                >
                  <XIcon size={14} />
                </button>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
