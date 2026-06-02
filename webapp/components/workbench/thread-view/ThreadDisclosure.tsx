/*
 * Exports:
 * - default ThreadDisclosure: render a styled details/summary disclosure with controlled or uncontrolled open state. Keywords: thread, disclosure, chevron.
 * - ThreadDisclosureStaticRow: render a disclosure-aligned non-expandable row with a dot marker. Keywords: thread, disclosure, static row, dot.
 * - Local helpers: joinClasses for compact className composition. Keywords: css, class names.
 */
"use client";

import { useEffect, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import ChevronIcon from "../ChevronIcon";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ThreadDisclosureProps = Omit<ComponentPropsWithoutRef<"details">, "children"> & {
  chevronClassName?: string;
  children: ReactNode;
  contentClassName?: string;
  defaultOpen?: boolean;
  initialOpen?: boolean;
  summary: ReactNode;
  summaryClassName?: string;
};

function isSummaryActionTarget(target: EventTarget | null) {
  return target instanceof Element
    && Boolean(target.closest("a, button, [data-thread-summary-action='true']"));
}

function shouldPreventSummaryActionDefault(target: EventTarget | null) {
  return target instanceof Element
    && Boolean(target.closest("button, [data-thread-summary-action='true']"));
}

export default function ThreadDisclosure ({
  chevronClassName,
  children,
  className,
  contentClassName,
  defaultOpen,
  initialOpen = false,
  onToggle,
  open,
  summary,
  summaryClassName,
  ...props
}: ThreadDisclosureProps) {
  const isControlled = typeof open === "boolean";
  const defaultIsOpen = Boolean(defaultOpen ?? initialOpen);
  const [hasUserToggled, setHasUserToggled] = useState(false);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(Boolean(open ?? defaultIsOpen));
  const isOpen = isControlled ? Boolean(open) : uncontrolledOpen;

  function markUserToggleIntent () {
    if (!isControlled) {
      setHasUserToggled(true);
    }
  }

  function handleSummaryKeyDown (event: KeyboardEvent<HTMLElement>) {
    if (isSummaryActionTarget(event.target)) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      markUserToggleIntent();
    }
  }

  function handleSummaryClick (event: MouseEvent<HTMLElement>) {
    if (isSummaryActionTarget(event.target)) {
      if (
        shouldPreventSummaryActionDefault(event.target)
        &&
        event.button === 0
        && !event.metaKey
        && !event.ctrlKey
        && !event.shiftKey
        && !event.altKey
      ) {
        event.preventDefault();
      }
      return;
    }

    markUserToggleIntent();
  }

  useEffect(() => {
    if (isControlled) {
      setUncontrolledOpen(Boolean(open));
      return;
    }

    if (!hasUserToggled) {
      setUncontrolledOpen(defaultIsOpen);
    }
  }, [defaultIsOpen, hasUserToggled, isControlled, open]);

  return (
    <details
      className={joinClasses("thread-disclosure min-w-0 max-w-full [&>summary::-webkit-details-marker]:hidden", className)}
      open={isOpen}
      onToggle={(event) => {
        if (!isControlled) {
          setUncontrolledOpen(event.currentTarget.open);
        }
        onToggle?.(event);
      }}
      {...props}
    >
      <summary
        className={joinClasses(
          "flex min-w-0 max-w-full items-center cursor-pointer list-none gap-2 text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none",
          summaryClassName,
        )}
        onClick={handleSummaryClick}
        onKeyDown={handleSummaryKeyDown}
      >
        <ChevronIcon
          data-thread-chevron
          className={joinClasses(
            "size-[1.1rem] transition-transform",
            chevronClassName,
          )}
        />
        <div className="min-w-0 flex-1">{summary}</div>
      </summary>
      <div className={joinClasses("min-w-0 max-w-full", contentClassName)}>{children}</div>
    </details>
  );
}

export function ThreadDisclosureStaticRow ({
  className,
  markerClassName,
  summary,
  summaryClassName,
}: {
  className?: string;
  markerClassName?: string;
  summary: ReactNode;
  summaryClassName?: string;
}) {
  return (
    <div className={joinClasses("min-w-0 max-w-full py-2", className)}>
      <div
        className={joinClasses(
          "flex min-w-0 max-w-full items-center gap-2 text-muted",
          summaryClassName,
        )}
      >
        <span className="flex size-[1.1rem] shrink-0 items-center justify-center" aria-hidden="true">
          <span
            className={joinClasses(
              "size-[0.3rem] rounded-full bg-current opacity-45",
              markerClassName,
            )}
          />
        </span>
        <div className="min-w-0 flex-1">{summary}</div>
      </div>
    </div>
  );
}
