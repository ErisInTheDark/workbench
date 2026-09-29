/*
 * Exports:
 * - default WorkbenchFolderSidebar: folder-scoped sidebar section with its folder picker above the children.
 */
"use client";

import type { ReactNode } from "react";

import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { ProjectFolderOption } from "workbench-shared/workbench/project/project-folder-address";
import WorkbenchProjectLocationMenu from "./WorkbenchProjectLocationMenu";

export default function WorkbenchFolderSidebar({
  children,
  folders,
  label,
  onSelect,
  selected,
}: {
  children: ReactNode;
  folders: readonly ProjectFolderOption[];
  label: string;
  onSelect: (location: ProjectLocationReference) => void;
  selected: ProjectLocationReference | null;
}) {
  return (
    <section className="shrink-0 border-t border-fg/10 pt-2 pb-3">
      <div className="px-1 pb-1">
        <WorkbenchProjectLocationMenu
          folders={folders}
          label={label}
          onSelect={onSelect}
          selected={selected}
        />
      </div>
      {children}
    </section>
  );
}
