/*
 * Keywords: search, sidebar, trigger.
 * Exports:
 * - default WorkbenchSearchInput: accessible sidebar search button.
 */
"use client";

export default function WorkbenchSearchInput({ onOpen }: { onOpen(): void }) {
  return (
    <button
      aria-label="Open workspace search"
      className="ml-5 mb-4 flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-xl px-3 text-left text-sm text-muted outline-none transition hover:bg-text/[0.07] hover:text-text focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={onOpen}
      type="button"
    >
      <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-search-icon lucide-search shrink-0">
        <path d="m21 21-4.34-4.34" />
        <circle cx="11" cy="11" r="8" />
      </svg>
      <span>Search</span>
    </button>
  );
}
