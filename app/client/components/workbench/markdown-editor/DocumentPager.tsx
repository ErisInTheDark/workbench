/*
 * Exports:
 * - default DocumentPager: the row after a document: previous and next markdown documents of its folder (folders are
 *   skipped) around a button to the folder index, each turning the same tab into its destination.
 */
"use client";

import type { ReactNode } from "react";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { withFileDestination } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { isMarkdownFile } from "workbench-shared/workbench/project/tree-utils";
import useFolderEntries from "../../../workbench/file/use-folder-entries";
import { useWorkbenchSwapTab } from "../../../workbench/navigation/use-workbench-project-navigation";
import IconButton from "../../ui/IconButton";
import Tooltip from "../../ui/Tooltip";
import { BookBookmarkIcon, ChevronLeftIcon, ChevronRightIcon } from "../workbench-icons";

function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export default function DocumentPager({ location, route }: { location: ProjectLocationReference | null; route: WorkbenchRoute }) {
  const listing = useFolderEntries(location, route.filePath);
  const swapTab = useWorkbenchSwapTab();
  const documents = listing?.entries.filter(entry => entry.type === "file" && isMarkdownFile(entry.path)) ?? [];
  const at = documents.findIndex(entry => entry.path === route.filePath);
  const previous = at > 0 ? documents[at - 1] : undefined;
  const next = at >= 0 ? documents[at + 1] : undefined;

  const step = (path: string | undefined, label: string, icon: ReactNode, side: "start" | "end") => (
    <Tooltip placement="top" delayMs={350} content={path ? fileName(path) : label}>
      <IconButton
        label={path ? `${label}: ${fileName(path)}` : label}
        title=""
        display="hover-border"
        disabled={!path}
        className={side === "start" ? "justify-self-start" : "justify-self-end"}
        onClick={() => { if (path) swapTab(withFileDestination(route, path)); }}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );

  return (
    <nav aria-label="Folder documents" className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-fg-alpha/8 pt-4">
      {step(previous?.path, "Previous document", <ChevronLeftIcon size={18} />, "start")}
      <Tooltip placement="top" delayMs={350} content="Folder index">
        <IconButton label="Folder index" title="" display="hover-border" onClick={() => swapTab(withFileDestination(route, route.filePath, true))}>
          <BookBookmarkIcon size={18} />
        </IconButton>
      </Tooltip>
      {step(next?.path, "Next document", <ChevronRightIcon size={18} />, "end")}
    </nav>
  );
}
