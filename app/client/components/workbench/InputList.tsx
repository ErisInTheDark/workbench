/*
 * Exports:
 * - default InputList: render a controlled list of labelled text inputs with optional row errors.
 */
"use client";

import { useLayoutEffect, useRef } from "react";
import { XIcon } from "./workbench-icons";

interface InputListRow<Id extends string | number> {
  id: Id;
  label: string;
  value: string;
  error?: string;
}

export default function InputList<Id extends string | number>({
  disabled,
  idPrefix,
  onBlur,
  onChange,
  onRemove,
  placeholder,
  rows,
}: {
  disabled?: boolean;
  idPrefix: string;
  onBlur?: () => void;
  onChange: (id: Id, value: string) => void;
  onRemove: (id: Id) => void;
  placeholder?: string;
  rows: readonly InputListRow<Id>[];
}) {
  const inputRefs = useRef(new Map<Id, HTMLInputElement>());
  const pendingFocusIndex = useRef<number | null>(null);

  useLayoutEffect(() => {
    const index = pendingFocusIndex.current;
    if (index === null) return;
    pendingFocusIndex.current = null;
    const row = rows[Math.min(index, rows.length - 1)];
    const input = row ? inputRefs.current.get(row.id) : null;
    input?.focus();
    input?.select();
  }, [rows]);

  return (
    <div
      className="divide-y divide-text/16 overflow-hidden rounded-[0.8rem] border border-text/16 bg-text/[0.03]"
      onBlur={event => {
        if (pendingFocusIndex.current === null && !event.currentTarget.contains(event.relatedTarget)) onBlur?.();
      }}
    >
      {rows.map((row, index) => {
        const inputId = `${idPrefix}-${row.id}`;
        const errorId = `${inputId}-issue`;
        return (
          <div key={row.id} className="relative focus-within:bg-text/[0.07]">
            <input
              ref={node => {
                if (node) inputRefs.current.set(row.id, node);
                else inputRefs.current.delete(row.id);
              }}
              id={inputId}
              aria-label={row.label}
              aria-invalid={Boolean(row.error)}
              aria-describedby={row.error ? errorId : undefined}
              autoComplete="off"
              className="w-full min-w-0 bg-transparent py-2 pl-3 pr-10 text-[0.85rem] text-text outline-none"
              disabled={disabled}
              onChange={event => onChange(row.id, event.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              type="text"
              value={row.value}
            />
            {index === rows.length - 1 && !row.value.trim() ? null : (
              <button
                aria-label={`Remove ${row.label}`}
                className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md bg-transparent text-fg/muted outline-none hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                disabled={disabled}
                onClick={() => {
                  pendingFocusIndex.current = index;
                  onRemove(row.id);
                }}
                type="button"
              >
                <XIcon size={14} />
              </button>
            )}
            {row.error ? <p id={errorId} role="alert" className="m-0 px-3 pb-2 text-[0.76rem] text-danger">{row.error}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
