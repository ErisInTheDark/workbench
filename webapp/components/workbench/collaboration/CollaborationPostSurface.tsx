/*
 * Exports:
 * - default CollaborationPostSurface: render expanded and collapsed Collaboration post surfaces with header metadata. Keywords: collaboration, post, surface, suggestion, collapse, metadata.
 * - Local helpers: class joining, relative time formatting, and interaction target detection. Keywords: classes, time, click, drag, collapse.
 */
"use client";

import type { KeyboardEvent, MouseEvent, ReactNode, PointerEvent as ReactPointerEvent } from "react";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatPostRelativeTime (updatedAt: number, now = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (elapsedSeconds < 45) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function isInteractiveTarget (target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("button,a,input,textarea,select,[contenteditable='true'],[role='button'],[data-collaboration-no-drag='true']"));
}

export default function CollaborationPostSurface ({
  author,
  authorLabel,
  canDrag,
  children,
  collapsedPreviewText = "",
  isActive = false,
  isClickable = false,
  isCollapsed = false,
  isPromptPost = false,
  menuAction,
  metadata,
  primaryAction,
  updatedAt,
  onClick,
  onPointerDown,
}: {
  author: "agent" | "user";
  authorLabel: string;
  canDrag: boolean;
  children: ReactNode;
  collapsedPreviewText?: string;
  isActive?: boolean;
  isClickable?: boolean;
  isCollapsed?: boolean;
  isPromptPost?: boolean;
  menuAction: ReactNode;
  metadata?: ReactNode;
  primaryAction?: ReactNode;
  updatedAt: number;
  onClick?: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const isUserPost = author === "user";
  const hasPrimaryAction = Boolean(primaryAction);
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (!isClickable || isInteractiveTarget(event.target)) {
      return;
    }

    onClick?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isClickable || isInteractiveTarget(event.target) || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    onClick?.();
  };

  if (isCollapsed) {
    return (
      <div
        tabIndex={isClickable ? 0 : undefined}
        aria-expanded={isClickable ? false : undefined}
        className={joinClasses(
          "group/post-surface flex min-w-0 items-center gap-2 rounded-[0.85rem] px-3 text-[0.82rem] leading-5 text-muted transition",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
          canDrag && "cursor-grab active:cursor-grabbing",
          isClickable && "cursor-pointer hover:text-text",
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onPointerDown={onPointerDown}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 font-medium text-text">{authorLabel}</span>
          <time className="shrink-0 opacity-55" dateTime={new Date(updatedAt).toISOString()}>{formatPostRelativeTime(updatedAt)}</time>
          {metadata ? <div className="min-w-0 shrink">{metadata}</div> : null}
          <span className="min-w-0 flex-1 truncate">{collapsedPreviewText || "Empty post"}</span>
        </div>
        <div className="shrink-0 opacity-100" data-collaboration-no-drag="true">
          {menuAction}
        </div>
      </div>
    );
  }

  return (
    <div
      tabIndex={isClickable ? 0 : undefined}
      aria-expanded={isClickable ? true : undefined}
      className={joinClasses(
        "group/post-surface rounded-[1.15rem] px-3 py-2 transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
        canDrag && "cursor-grab active:cursor-grabbing",
        isClickable && "cursor-pointer",
        isActive || isPromptPost
          ? "bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)]"
          : isUserPost
            ? "bg-[color-mix(in_srgb,var(--text)_3%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)]"
            : "hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)]",
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={onPointerDown}
    >
      <div className="mb-0.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[0.74rem] font-medium text-muted">
            <span>{authorLabel}</span>
            <time className="opacity-55" dateTime={new Date(updatedAt).toISOString()}>{formatPostRelativeTime(updatedAt)}</time>
            {metadata}
          </div>
        </div>
        <div
          className={joinClasses(
            "flex shrink-0 items-center gap-1 opacity-100 md:transition md:group-hover/post-surface:opacity-100 md:focus-within:opacity-100",
            hasPrimaryAction ? "md:opacity-100" : "md:opacity-0",
          )}
          data-collaboration-no-drag="true"
        >
          {primaryAction}
          {menuAction}
        </div>
      </div>
      {children}
    </div>
  );
}
