"use client";

import { useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

import ChevronIcon from "../ChevronIcon";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ThreadDisclosureProps = Omit<ComponentPropsWithoutRef<"details">, "children"> & {
  children: ReactNode;
  contentClassName?: string;
  initialOpen?: boolean;
  summary: ReactNode;
  summaryClassName?: string;
};

export default function ThreadDisclosure ({
  children,
  className,
  contentClassName,
  initialOpen = false,
  onToggle,
  open,
  summary,
  summaryClassName,
  ...props
}: ThreadDisclosureProps) {
  const isControlled = typeof open === "boolean";
  const [uncontrolledOpen, setUncontrolledOpen] = useState(Boolean(open ?? initialOpen));
  const isOpen = isControlled ? Boolean(open) : uncontrolledOpen;

  useEffect(() => {
    if (isControlled) {
      setUncontrolledOpen(Boolean(open));
    }
  }, [isControlled, open]);

  return (
    <details
      className={joinClasses("min-w-0 max-w-full [&>summary::-webkit-details-marker]:hidden", className)}
      open={isControlled || initialOpen ? isOpen : undefined}
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
      >
        <ChevronIcon
          data-thread-chevron
          className={joinClasses(
            "size-[1.1rem] transition-transform",
            isOpen ? "rotate-90" : "rotate-0",
          )}
        />
        <span className="min-w-0 flex-1">{summary}</span>
      </summary>
      <div className={joinClasses("min-w-0 max-w-full", contentClassName)}>{children}</div>
    </details>
  );
}
