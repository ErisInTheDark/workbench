/*
 * Exports:
 * - default ThreadCheckpointCompareItem: adapt path-scoped checkpoint counts into the established file-change renderer. Keywords: thread, checkpoint, compare, file change.
 */
"use client";

import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { ThreadFileChangeList } from "./ThreadFileChangeItem";

export default function ThreadCheckpointCompareItem({
  changes,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  changes: Array<{ additions: number; deletions: number; path: string; status: "A" | "D" | "M" | "U" }>;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <ThreadFileChangeList
      changes={changes.map((change, sourceChangeIndex) => ({
        change: {
          diff: "",
          kind: change.status === "A"
            ? { type: "add" as const }
            : change.status === "D"
              ? { type: "delete" as const }
              : { move_path: null, type: "update" as const },
          path: change.path,
        },
        detailsAvailable: false,
        sourceChangeIndex,
        sourceItemId: "checkpoint-compare",
        summaryTotals: {
          additions: change.additions,
          deletions: change.deletions,
        },
      }))}
      projectFilePaths={projectFilePaths}
      projectId={projectId}
      projectRootPath={projectRootPath}
      workspaceRoots={workspaceRoots}
    />
  );
}
