/*
 * Exports:
 * - default WorkbenchSearchResultItem: compact search row for non-materialised and non-sidebar results.
 */
"use client";

import type { ComponentType } from "react";
import type { WorkbenchSearchResult } from "workbench-shared/workbench/search/workbench-search";
import { FolderOpenIcon, GearIcon, OpenThreadIcon, ProjectIcon, SparkleIcon, type IconProps } from "./workbench-icons";

const RESULT_PRESENTATION: Record<WorkbenchSearchResult["kind"], {
  Icon: ComponentType<IconProps>;
  iconSize: NonNullable<IconProps["size"]>;
  label: string;
}> = {
  action: { Icon: SparkleIcon, iconSize: 16, label: "Action" },
  file: { Icon: FolderOpenIcon, iconSize: 16, label: "File" },
  project: { Icon: ProjectIcon, iconSize: 16, label: "Project" },
  projectSetting: { Icon: GearIcon, iconSize: 20, label: "Project setting" },
  thread: { Icon: OpenThreadIcon, iconSize: 16, label: "Thread" },
};

export default function WorkbenchSearchResultItem({
  id,
  onActivate,
  result,
  selected,
}: {
  id: string;
  onActivate(): void;
  result: WorkbenchSearchResult;
  selected: boolean;
}) {
  const { Icon, iconSize, label } = RESULT_PRESENTATION[result.kind];
  return (
    <button
      aria-selected={selected}
      className={`
        group/search-row relative isolate flex min-h-11 w-full items-center gap-1.5 rounded-[0.8rem] px-2 py-1 text-left text-[0.9rem] leading-6 text-text outline-none md:min-h-0
        focus-visible:ring-2 focus-visible:ring-accent-soft
      `}
      id={id}
      onClick={onActivate}
      role="option"
      title={result.detail}
      type="button"
    >
      <svg
        aria-hidden="true"
        className={`
          pointer-events-none absolute inset-0 z-0 size-full text-muted transition-opacity duration-75 ease-out
          ${selected ? "opacity-100" : "opacity-0 group-hover/search-row:opacity-100 group-focus-visible/search-row:opacity-100"}
        `}
      >
        <rect x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="12.8" fill="color-mix(in srgb, var(--text) 4%, transparent)" stroke="currentColor" strokeWidth="1" strokeOpacity="0.24" />
      </svg>
      <span aria-hidden="true" className="relative inline-flex shrink-0 items-center text-muted"><Icon size={iconSize} /></span>
      <span className={`relative min-w-0 truncate ${selected ? "font-semibold" : "font-medium"}`}>{result.title}</span>
      <span className="relative min-w-0 flex-1 truncate text-[0.72rem] text-muted">{result.detail}</span>
      <span className="relative shrink-0 text-[0.72rem] text-muted">{label}</span>
    </button>
  );
}
