/*
 * Exports:
 * - default ThreadGitArcCommitList: list intersecting commits across arc cards as commit rows that open onto their changed files.
 */
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import ThreadCheckpointCommitCard from "./ThreadCheckpointCommitCard";

export default function ThreadGitArcCommitList({
  commits, projectFilePaths, projectId, projectRootPath, workspaceRoots,
}: {
  commits: Array<{ commit: string; subject: string; paths: string[] }>;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <div className="py-1">
      {commits.map(({ commit, paths, subject }) => (
        <ThreadCheckpointCommitCard
          key={commit}
          paths={paths}
          projectFilePaths={projectFilePaths}
          projectId={projectId}
          projectRootPath={projectRootPath}
          sourceItemId={`intersecting-commit:${commit}`}
          state={{ status: "summary", summary: { changes: null, committedSha: commit, description: "", title: subject || "No commit subject" } }}
          workspaceRoots={workspaceRoots}
        />
      ))}
    </div>
  );
}
