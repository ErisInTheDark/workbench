"use client";

import { useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

import ChevronIcon from "../ChevronIcon";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ThreadDisclosureProps = Omit<ComponentPropsWithoutRef<"details">, "children"> & {
  children: ReactNode;
  contentClassName?: string;
  summary: ReactNode;
  summaryClassName?: string;
};

export default function ThreadDisclosure ({
  children,
  className,
  contentClassName,
  onToggle,
  open,
  summary,
  summaryClassName,
  ...props
}: ThreadDisclosureProps) {
  const [isOpen, setIsOpen] = useState(Boolean(open));

  useEffect(() => {
    if (typeof open === "boolean") {
      setIsOpen(open);
    }
  }, [open]);

  return (
    <details
      className={joinClasses("[&>summary::-webkit-details-marker]:hidden", className)}
      open={open}
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
        onToggle?.(event);
      }}
      {...props}
    >
      <summary
        className={joinClasses(
          "flex items-center cursor-pointer list-none gap-2 text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none",
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
      <div className={contentClassName}>{children}</div>
    </details>
  );
}
