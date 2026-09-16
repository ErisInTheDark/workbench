/*
 * Exports:
 * - default ThreadDisclosure: render a styled details/summary disclosure with controlled or uncontrolled open state.
 * - ThreadDisclosureStaticRow: disclosure-aligned static row or optional accessible action with a supplied marker.
 */
"use client";

import { useEffect, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import ChevronIcon from "../ChevronIcon";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ThreadDisclosureProps = Omit<ComponentPropsWithoutRef<"details">, "children"> & {
  chevronClassName?: string;
  hideChevron?: boolean;
  children?: ReactNode;
  compactSummary?: boolean;
  contentClassName?: string;
  defaultOpen?: boolean;
  initialOpen?: boolean;
  leading?: ReactNode;
  leadingClassName?: string;
  leadingLabel?: string;
  renderContent?: () => ReactNode;
  summary: ReactNode;
  summaryClassName?: string;
  summaryContentClassName?: string;
};

function isSummaryActionTarget(target: EventTarget | null) {
  return target instanceof Element
    && Boolean(target.closest("a, button, input, label, select, textarea, [data-thread-summary-action='true']"));
}

function shouldPreventSummaryActionDefault(target: EventTarget | null) {
  if (!(target instanceof Element) || target.closest("input, label, select, textarea")) {
    return false;
  }
  return Boolean(target.closest("button, [data-thread-summary-action='true']"));
}

export default function ThreadDisclosure ({
  chevronClassName,
  hideChevron = false,
  children,
  className,
  compactSummary = false,
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
  summaryContentClassName,
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
          "flex min-w-0 items-center cursor-pointer list-none text-fg/muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none",
          compactSummary ? "gap-1" : "max-w-full gap-2",
          summaryClassName,
        )}
        onClick={handleSummaryClick}
        onKeyDown={handleSummaryKeyDown}
      >
        {!hideChevron ? <ChevronIcon
          data-thread-chevron
          className={joinClasses(
            "transition-transform",
            chevronClassName,
          )}
          size={18}
        /> : null}
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
        <div className={joinClasses("min-w-0 flex-1", summaryContentClassName)}>{summary}</div>
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
  onClick,
  summary,
  summaryClassName,
}: {
  className?: string;
  marker?: ReactNode;
  markerClassName?: string;
  markerLabel?: string;
  onClick?: () => void;
  summary: ReactNode;
  summaryClassName?: string;
}) {
  const Row = onClick ? "button" : "div";
  return (
    <div className={joinClasses("min-w-0 max-w-full py-2", className)}>
      <Row
        type={onClick ? "button" : undefined}
        onClick={onClick}
        className={joinClasses(
          "flex min-w-0 max-w-full items-center gap-2 text-fg/muted",
          onClick ? "group/worked w-full cursor-pointer text-left transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none" : undefined,
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
      </Row>
    </div>
  );
}
