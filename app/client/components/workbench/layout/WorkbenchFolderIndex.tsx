/*
 * Exports:
 * - default WorkbenchFolderIndex: a file tab turned into its folder's index: every file and folder beside the focused
 *   entry, scrolled to it, with a row up to the parent folder. Workbench documents open in the same tab, other files
 *   through the file-open policy, and folders open their own index.
 */
"use client";

import { useContext, useEffect, useRef } from "react";
import type { TreeNode } from "workbench-shared/types";
import { withFileDestination, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { getWorkbenchFileKind } from "workbench-shared/workbench/project/tree-utils";
import useFolderEntries from "../../../workbench/file/use-folder-entries";
import { FileActionContext } from "../../../workbench/file/use-file";
import { useWorkbenchSwapTab } from "../../../workbench/navigation/use-workbench-project-navigation";
import FileKindIcon from "../file-kind-icon";
import { CornerLeftUpIcon, FolderClosedIcon } from "../workbench-icons";
import WorkbenchLoadingSpinner from "../WorkbenchLoadingSpinner";

const rowClassName = `
  flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.95rem] text-text transition-colors
  enabled:cursor-pointer enabled:hover:bg-fg/6 disabled:text-fg/45 focus-visible:(outline-none ring-2 ring-accent-soft)
`;

export default function WorkbenchFolderIndex({
  location,
  route,
}: {
  location: ProjectLocationReference | null;
  route: WorkbenchRoute;
}) {
  const listing = useFolderEntries(location, route.filePath);
  const swapTab = useWorkbenchSwapTab();
  const openFile = useContext(FileActionContext);
  const focused = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    focused.current?.scrollIntoView({ block: "center" });
    focused.current?.focus({ preventScroll: true });
  }, [route.filePath, Boolean(listing)]);

  if (!listing) return <WorkbenchLoadingSpinner label="Loading folder" />;

  const open = (entry: TreeNode) => {
    if (entry.type === "directory") {
      const first = entry.children[0];
      if (first) swapTab(withFileDestination(route, first.path, true));
    } else if (getWorkbenchFileKind(entry.path)) {
      swapTab(withFileDestination(route, entry.path));
    } else {
      void openFile?.({ path: entry.path, projectId: location?.projectId ?? null }, location);
    }
  };

  return (
    <nav aria-label={`Index of ${listing.folder || "project"}`} className="mx-auto w-full max-w-content py-6">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {listing.folder ? (
          <li>
            <button type="button" className={rowClassName} onClick={() => swapTab(withFileDestination(route, listing.folder, true))}>
              <CornerLeftUpIcon size={16} className="shrink-0 text-fg/muted" />
              <span className="text-fg/muted">..</span>
            </button>
          </li>
        ) : null}
        {listing.entries.map(entry => {
          const isFocused = entry.path === route.filePath;
          return (
            <li key={entry.path}>
              <button
                ref={isFocused ? focused : undefined}
                type="button"
                aria-current={isFocused ? "page" : undefined}
                disabled={entry.type === "directory" && !entry.children.length}
                className={`${rowClassName} ${isFocused ? "bg-fg/8 font-semibold" : ""}`}
                onClick={() => open(entry)}
              >
                {entry.type === "directory"
                  ? <FolderClosedIcon size={16} className="shrink-0 text-fg/muted" />
                  : <FileKindIcon path={entry.path} size={16} />}
                <span className="min-w-0 truncate">{entry.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
