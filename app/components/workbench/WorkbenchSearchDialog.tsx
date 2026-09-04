/*
 * Exports:
 * - default WorkbenchSearchDialog: full-screen accessible search dialog and keyboard-driven result list. Keywords: search, dialog, listbox, keyboard.
 */
"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import type WorkbenchSearchController from "../../workbench/search/WorkbenchSearchController";

export default function WorkbenchSearchDialog({ controller }: { controller: WorkbenchSearchController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!snapshot.isOpen) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => restoreFocusRef.current?.focus();
  }, [snapshot.isOpen]);

  useEffect(() => {
    document.getElementById(`workbench-search-result-${snapshot.selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [snapshot.selectedIndex]);

  if (!snapshot.isOpen) return null;
  return (
    <div
      aria-label="Workspace search"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-background/70 px-3 pb-8 pt-[8vh] backdrop-blur-md md:px-8 md:pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) controller.close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          controller.close();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input, button:not([disabled])"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      role="dialog"
    >
      <div className="flex max-h-[78vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-background/90 shadow-2xl ring-1 ring-text/10">
        <input
          aria-activedescendant={snapshot.results.length ? `workbench-search-result-${snapshot.selectedIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls="workbench-search-results"
          aria-expanded="true"
          className="h-20 w-full shrink-0 bg-transparent px-6 text-2xl text-text outline-none placeholder:text-muted md:h-24 md:px-8 md:text-3xl"
          onChange={(event) => controller.setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); controller.moveSelection(1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); controller.moveSelection(-1); }
            else if (event.key === "Enter") { event.preventDefault(); controller.activateSelected(); }
            else if (event.key === "Escape") { event.preventDefault(); controller.close(); }
          }}
          placeholder="Search"
          ref={inputRef}
          role="combobox"
          type="search"
          value={snapshot.query}
        />
        <div aria-live="polite" className="sr-only">
          {snapshot.isLoading ? "Searching" : `${snapshot.results.length} results`}
        </div>
        <div className="h-px shrink-0 bg-gradient-to-r from-transparent via-text/15 to-transparent" />
        <div
          className="explorer-scrollbar min-h-24 flex-1 overflow-y-auto px-2 py-3 md:px-4"
          id="workbench-search-results"
          role="listbox"
        >
          {snapshot.error ? <p className="px-4 py-5 text-sm text-red-500">{snapshot.error}</p> : null}
          {!snapshot.error && !snapshot.isLoading && snapshot.results.length === 0 ? (
            <p className="px-4 py-5 text-sm text-muted">No matching results.</p>
          ) : null}
          {snapshot.results.map((result, index) => (
            <button
              aria-selected={index === snapshot.selectedIndex}
              className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 rounded-2xl px-4 py-3 text-left outline-none transition hover:bg-text/[0.06] focus-visible:bg-text/[0.06]${index === snapshot.selectedIndex ? " bg-accent-soft" : ""}`}
              id={`workbench-search-result-${index}`}
              key={result.id}
              onClick={() => controller.activate(result)}
              onMouseMove={() => {
                const delta = index - controller.getSnapshot().selectedIndex;
                if (delta) controller.moveSelection(delta);
              }}
              role="option"
              type="button"
            >
              <span className="min-w-0 truncate text-base font-medium text-text">{result.title}</span>
              <span className="self-center text-[0.7rem] uppercase tracking-[0.12em] text-muted">{result.kind}</span>
              <span className="col-span-2 min-w-0 truncate text-sm text-muted">{result.detail}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
