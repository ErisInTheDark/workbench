/*
 * Exports:
 * - default WorkbenchPill: compact rounded label with an optional leading glyph, hover/focus/touch remove button, click action and tooltip.
 */
"use client";

import type { ReactNode } from "react";

import Tooltip from "../ui/Tooltip";
import { XIcon } from "./workbench-icons";

const fadeForRemove = `
  group-hover/pill:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
  group-focus-within/pill:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
  coarse-touch:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
`;

export default function WorkbenchPill({
  children,
  className = "",
  icon,
  label,
  onClick,
  onRemove,
  pending = false,
  pressed,
  removeLabel,
  title,
  tooltip,
}: {
  children: ReactNode;
  /** Tone classes: background, ring and text colour. */
  className: string;
  icon?: ReactNode;
  /** Accessible name of the click action. */
  label?: string;
  onClick?: () => void;
  onRemove?: () => void;
  pending?: boolean;
  pressed?: boolean;
  removeLabel?: string;
  title?: string;
  tooltip?: ReactNode;
}) {
  const body = (
    <>
      {icon ? <span aria-hidden="true" className="flex shrink-0">{icon}</span> : null}
      <span className={`min-w-0 max-w-40 truncate ${onRemove ? fadeForRemove : ""}`}>{children}</span>
    </>
  );
  const bodyClassName = `
    inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[0.76em] font-medium
    ${onRemove ? "pr-3" : ""}
    ${className}
  `;
  const pill = (
    <span className={`group/pill relative inline-flex max-w-full ${pending ? "opacity-50" : ""}`} title={tooltip ? undefined : title}>
      {onClick ? (
        <button
          aria-label={label}
          aria-pressed={pressed}
          className={`
            ${bodyClassName}
            cursor-pointer transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
          `}
          onClick={onClick}
          type="button"
        >
          {body}
        </button>
      ) : <span className={bodyClassName}>{body}</span>}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          className={`
            absolute inset-y-0 right-1 my-auto grid size-5 place-items-center rounded-full text-fg/muted opacity-0 transition
            hover:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] hover:text-text
            group-hover/pill:opacity-100 focus-visible:opacity-100 coarse-touch:opacity-100
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
            disabled:cursor-not-allowed motion-reduce:transition-none
          `}
          disabled={pending}
          onClick={onRemove}
          title={removeLabel}
        >
          <XIcon size={12} />
        </button>
      ) : null}
    </span>
  );
  return tooltip ? <Tooltip content={tooltip} interactive placement="top">{pill}</Tooltip> : pill;
}
