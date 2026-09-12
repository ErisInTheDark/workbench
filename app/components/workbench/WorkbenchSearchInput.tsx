/*
 * Exports:
 * - default WorkbenchSearchInput: accessible sidebar search button.
 */
"use client";

import { SearchIcon } from "./workbench-icons";

export default function WorkbenchSearchInput({ onOpen }: { onOpen(): void }) {
  return (
    <button
      aria-label="Open workspace search"
      className="ml-5 mb-4 flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-xl px-3 text-left text-sm text-muted outline-none transition hover:bg-text/[0.07] hover:text-text focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={onOpen}
      type="button"
    >
      <SearchIcon className="shrink-0" size={16} />
      <span>Search</span>
    </button>
  );
}
