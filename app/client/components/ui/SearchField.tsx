/*
 * Exports:
 * - default SearchField: a flush pill search input with a glyph, a live status, and a clear button; Escape clears, then
 *   leaves; `shortcut` lets `/` focus it from anywhere outside editable fields.
 */
"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { SearchIcon, XIcon } from "../workbench/workbench-icons";
import Keybind from "./Keybind";

const SHORTCUT = "/";

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest("input,textarea,select")));
}

export default function SearchField({
  ariaLabel,
  className = "",
  onChange,
  placeholder,
  shortcut = false,
  status,
  value,
}: {
  ariaLabel: string;
  className?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  shortcut?: boolean;
  /** Shown beside the clear button while there is a query, such as a match count. */
  status?: ReactNode;
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shortcut) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== SHORTCUT || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [shortcut]);

  return (
    <div
      className={`
        group/search relative flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-fg/5 pl-2.5 pr-1 text-fg/muted transition
        focus-within:bg-fg/7 focus-within:text-text focus-within:ring-2 focus-within:ring-accent-soft
        ${className}
      `}
      role="search"
    >
      <SearchIcon className="shrink-0" size={14} />
      <input
        aria-label={ariaLabel}
        autoComplete="off"
        className="
          h-full min-w-0 flex-1 bg-transparent text-[0.8rem] text-text outline-none placeholder:text-fg/45
          [&::-webkit-search-cancel-button]:appearance-none
        "
        enterKeyHint="search"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (value) onChange("");
          else event.currentTarget.blur();
        }}
        placeholder={placeholder}
        ref={inputRef}
        spellCheck={false}
        type="search"
        value={value}
      />
      {value ? (
        <>
          {status ? <span className="shrink-0 whitespace-nowrap text-[0.72rem] tabular-nums text-fg/muted">{status}</span> : null}
          <button
            aria-label="Clear search"
            className="
              inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg/muted
              hover:bg-fg/8 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
            "
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            type="button"
          >
            <XIcon size={12} />
          </button>
        </>
      ) : shortcut ? (
        <span aria-hidden="true" className="shrink-0 pr-1 transition-opacity group-focus-within/search:opacity-0">
          <Keybind keys={[SHORTCUT]} />
        </span>
      ) : null}
    </div>
  );
}
