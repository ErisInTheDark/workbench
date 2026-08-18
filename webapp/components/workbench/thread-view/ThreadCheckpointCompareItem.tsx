/*
 * Exports:
 * - default ThreadCheckpointCompareItem: render path-scoped checkpoint change counts without unified diff content. Keywords: thread, checkpoint, compare, additions, deletions.
 */
"use client";

import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import ProjectFilePath from "../ProjectFilePath";

export default function ThreadCheckpointCompareItem({
  changes,
  projectFilePaths,
  projectId,
}: {
  changes: Array<{ additions: number; deletions: number; path: string; status: "A" | "D" | "M" | "U" }>;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (!changes.length) {
    return <p className="m-0 py-2 text-[0.88em] text-muted">No selected paths changed.</p>;
  }

  return (
    <div className="divide-y divide-[color-mix(in_srgb,var(--text)_8%,transparent)]">
      {changes.map((change) => (
        <div key={change.path} className="flex min-w-0 items-center gap-3 py-2.5 text-[0.88em]">
          <span className="w-4 shrink-0 font-mono text-muted" aria-label={`Git status ${change.status}`}>{change.status}</span>
          <ProjectFilePath
            className="min-w-0 flex-1 truncate"
            disambiguationPaths={projectFilePaths}
            path={change.path}
            projectId={projectId}
          />
          <span className="flex shrink-0 gap-2 font-mono text-[0.86em]">
            {change.additions ? <span className="text-[color:color-mix(in_srgb,var(--success)_78%,var(--text)_22%)]">+{change.additions}</span> : null}
            {change.deletions ? <span className="text-[color:color-mix(in_srgb,var(--danger)_78%,var(--text)_22%)]">-{change.deletions}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
