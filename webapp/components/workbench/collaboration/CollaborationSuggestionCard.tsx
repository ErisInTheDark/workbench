/*
 * Exports:
 * - default CollaborationSuggestionCard: render collapsible Collaboration suggestion cards with window-style controls. Keywords: collaboration, suggestions, collapse, dismiss, window controls.
 */
"use client";

import type { KeyboardEvent, ReactNode } from "react";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function CollaborationSuggestionCard ({
  children,
  isDimmed = false,
  isOpen,
  onCollapse,
  onDismiss,
  onOpen,
  rationale,
  title,
}: {
  children: ReactNode;
  isDimmed?: boolean;
  isOpen: boolean;
  onCollapse: () => void;
  onDismiss: () => void;
  onOpen: () => void;
  rationale?: string;
  title: string;
}) {
  const openFromCard = () => {
    if (!isOpen) {
      onOpen();
    }
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isOpen || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    onOpen();
  };

  return (
    <div
      role={isOpen ? undefined : "button"}
      tabIndex={isOpen ? undefined : 0}
      aria-expanded={isOpen}
      className={joinClasses(
        "relative transition",
        isOpen
          ? "pt-0"
          : "rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-3 cursor-pointer hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
        isDimmed && "opacity-75",
      )}
      onClick={openFromCard}
      onKeyDown={handleCardKeyDown}
    >
      <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1">
        {isOpen ? (
          <button
            type="button"
            aria-label="Collapse suggestion"
            title="Collapse suggestion"
            className="inline-flex size-8 items-center justify-center rounded-full text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            onClick={(event) => {
              event.stopPropagation();
              onCollapse();
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M4 8h8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss suggestion"
          title="Dismiss suggestion"
          className="inline-flex size-8 items-center justify-center rounded-full text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          </svg>
        </button>
      </div>
      {!isOpen ? (
        <div className="px-1 pr-18">
          <h3 className="m-0 text-[0.98rem] font-semibold leading-5 text-text">{title}</h3>
          {rationale ? (
            <p className="mt-1 mb-0 text-[0.84rem] leading-5 text-muted">{rationale}</p>
          ) : null}
        </div>
      ) : null}
      {isOpen ? (
        <div>
          {children}
        </div>
      ) : null}
    </div>
  );
}
