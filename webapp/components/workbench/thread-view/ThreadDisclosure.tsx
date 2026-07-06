/*
 * Exports:
 * - default ThreadDisclosure: render a styled details/summary disclosure with controlled or uncontrolled open state. Keywords: thread, disclosure, chevron.
 * - ThreadDisclosureStaticRow: render a disclosure-aligned non-expandable row with a dot or supplied marker. Keywords: thread, disclosure, static row, marker.
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
  children?: ReactNode;
  contentClassName?: string;
  defaultOpen?: boolean;
  initialOpen?: boolean;
  leading?: ReactNode;
  leadingClassName?: string;
  leadingLabel?: string;
  renderContent?: () => ReactNode;
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
  leading,
  leadingClassName,
  leadingLabel,
  onToggle,
  open,
  renderContent,
  summary,
  summaryClassName,
  ...props
}: ThreadDisclosureProps) {
  const isControlled = typeof open === "boolean";
  const defaultIsOpen = Boolean(defaultOpen ?? initialOpen);
  const [hasUserToggled, setHasUserToggled] = useState(false);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(Boolean(open ?? defaultIsOpen));
  const isOpen = isControlled ? Boolean(open) : uncontrolledOpen;
  const [hasMountedContent, setHasMountedContent] = useState(isOpen);

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

  useEffect(() => {
    if (isOpen) {
      setHasMountedContent(true);
    }
  }, [isOpen]);

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
        {leading ? (
          <span
            className={joinClasses("flex size-[1.1rem] shrink-0 items-center justify-center", leadingClassName)}
            aria-hidden={leadingLabel ? undefined : "true"}
            aria-label={leadingLabel}
            role={leadingLabel ? "img" : undefined}
          >
            {leading}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">{summary}</div>
      </summary>
      {hasMountedContent ? (
        <div className={joinClasses("min-w-0 max-w-full", contentClassName)}>{renderContent ? renderContent() : children}</div>
      ) : null}
    </details>
  );
}

export function ThreadDisclosureStaticRow ({
  className,
  marker,
  markerClassName,
  markerLabel,
  summary,
  summaryClassName,
}: {
  className?: string;
  marker?: ReactNode;
  markerClassName?: string;
  markerLabel?: string;
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
        <span
          className={joinClasses("flex size-[1.1rem] shrink-0 items-center justify-center", markerClassName)}
          aria-hidden={markerLabel ? undefined : "true"}
          aria-label={markerLabel}
          role={markerLabel ? "img" : undefined}
        >
          {marker ?? (
            <span
              className="size-[0.3rem] rounded-full bg-current opacity-45"
            />
          )}
        </span>
        <div className="min-w-0 flex-1">{summary}</div>
      </div>
    </div>
  );
}
