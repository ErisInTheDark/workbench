/*
 * Exports:
 * - default WorkbenchSearchResultItem: compact search row for results without a sidebar row; thread hits keep the thread row's shape.
 * - WorkbenchSearchExcerpt: the clipped message excerpt explaining why a thread matched.
 * - searchSectionLabel: heading for the dialog section holding one kind of result.
 * - searchFilterLabel: short label for the filter selecting one kind, or every kind.
 */
"use client";

import type { ComponentType, ReactNode } from "react";
import type { WorkbenchSearchKind, WorkbenchSearchResult } from "workbench-shared/workbench/search/workbench-search";
import { FileIcon, GearIcon, MessagesCircleIcon, ProjectIcon, SparkleIcon, type IconProps } from "../workbench-icons";

const RESULT_PRESENTATION: Record<WorkbenchSearchKind, {
  filter: string;
  Icon: ComponentType<IconProps>;
  iconSize: NonNullable<IconProps["size"]>;
  section: string;
}> = {
  action: { filter: "Actions", Icon: SparkleIcon, iconSize: 16, section: "Actions" },
  file: { filter: "Files", Icon: FileIcon, iconSize: 16, section: "Files" },
  project: { filter: "Projects", Icon: ProjectIcon, iconSize: 16, section: "Projects" },
  projectSetting: { filter: "Settings", Icon: GearIcon, iconSize: 20, section: "Project settings" },
  thread: { filter: "Threads", Icon: MessagesCircleIcon, iconSize: 16, section: "Threads" },
};

export function searchSectionLabel(kind: WorkbenchSearchKind) {
  return RESULT_PRESENTATION[kind].section;
}

export function searchFilterLabel(kind: WorkbenchSearchKind | null) {
  return kind ? RESULT_PRESENTATION[kind].filter : "All";
}

/** Older daemons send the excerpt as `detail`; newer ones say whose message it is. */
export function WorkbenchSearchExcerpt({ result }: { result: Extract<WorkbenchSearchResult, { kind: "thread" }> }) {
  const text = result.excerpt?.text ?? result.detail;
  if (!text) return null;
  return (
    <span className="line-clamp-2 break-words leading-[1.45]" title={text}>
      {result.excerpt ? <span className="font-medium text-text/80">{result.excerpt.role === "user" ? "You" : "Agent"} · </span> : null}
      {text}
    </span>
  );
}

export default function WorkbenchSearchResultItem({
  eyebrow,
  id,
  onActivate,
  result,
  selected,
}: {
  /** Shown above the title, such as the project a thread hit belongs to. */
  eyebrow?: ReactNode;
  id: string;
  onActivate(): void;
  result: WorkbenchSearchResult;
  selected: boolean;
}) {
  const { Icon, iconSize } = RESULT_PRESENTATION[result.kind];
  const thread = result.kind === "thread" ? result : null;
  return (
    <button
      aria-selected={selected}
      className={`
        group/search-row relative isolate flex min-h-11 w-full min-w-0 flex-col items-stretch rounded-[0.8rem] px-2 py-1 text-left text-[0.9rem] leading-6 text-text outline-none md:min-h-0
        focus-visible:ring-2 focus-visible:ring-accent-soft
      `}
      id={id}
      onClick={onActivate}
      role="option"
      title={thread ? undefined : result.detail || undefined}
      type="button"
    >
      <svg
        aria-hidden="true"
        className={`
          pointer-events-none absolute inset-0 z-0 size-full text-fg/muted transition-opacity duration-75 ease-out
          ${selected ? "opacity-100" : "opacity-0 group-hover/search-row:opacity-100 group-focus-visible/search-row:opacity-100"}
        `}
      >
        <rect x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="12.8" fill="color-mix(in srgb, var(--text) 4%, transparent)" stroke="currentColor" strokeWidth="1" strokeOpacity="0.24" />
      </svg>
      {eyebrow ? <span className="relative flex min-w-0 py-0.5">{eyebrow}</span> : null}
      <span className="relative flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="inline-flex shrink-0 items-center text-fg/muted"><Icon size={iconSize} /></span>
        <span className={`min-w-0 truncate ${selected ? "font-semibold" : "font-medium"}`}>{result.title}</span>
        {thread ? null : <span className="min-w-0 flex-1 truncate text-[0.72rem] text-fg/muted">{result.detail}</span>}
      </span>
      {thread ? (
        <span className="relative min-w-0 pb-0.5 pl-[1.375rem] text-[0.72rem] text-fg/muted">
          <WorkbenchSearchExcerpt result={thread} />
        </span>
      ) : null}
    </button>
  );
}
