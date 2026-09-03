import type { ComponentPropsWithoutRef } from "react";

function joinClasses(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ChevronIcon({
  className,
  ...props
}: ComponentPropsWithoutRef<"svg">) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      className={joinClasses("shrink-0", className)}
      {...props}
    >
      <path d="M7 5.75 12 10 7 14.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
