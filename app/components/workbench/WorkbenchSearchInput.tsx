/*
 * Exports:
 * - default WorkbenchSearchInput: accessible sidebar trigger styled as a search input. Keywords: search, sidebar, trigger.
 */
"use client";

export default function WorkbenchSearchInput({ onOpen }: { onOpen(): void }) {
  return (
    <input
      aria-label="Open workspace search"
      className="mx-2 mb-4 h-10 shrink-0 cursor-pointer rounded-xl bg-text/[0.035] px-3 text-sm text-text outline-none transition placeholder:text-muted hover:bg-text/[0.07] focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      placeholder="Search"
      readOnly
      type="search"
    />
  );
}
