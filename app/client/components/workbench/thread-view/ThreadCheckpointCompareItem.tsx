/*
 * Exports:
 * - default ThreadCheckpointCompareItem: adapt path-scoped checkpoint counts into the established file-change renderer. Keywords: thread, checkpoint, compare, file change.
 */
"use client";

import { ThreadFileChangeList } from "./ThreadFileChangeItem";

export default function ThreadCheckpointCompareItem({
  changes,
}: {
  changes: Array<{ additions: number; deletions: number; path: string; status: "A" | "D" | "M" | "U" }>;
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
    />
  );
}
