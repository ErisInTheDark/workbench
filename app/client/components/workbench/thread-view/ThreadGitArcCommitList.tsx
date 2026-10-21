/*
 * Exports:
 * - default ThreadGitArcCommitList: list intersecting commits across arc cards as commit rows that open onto their changed files.
 */
import ThreadCheckpointCommitCard from "./ThreadCheckpointCommitCard";

export default function ThreadGitArcCommitList({
  commits,
}: {
  commits: Array<{ commit: string; subject: string; paths: string[] }>;
}) {
  return (
    <div className="py-1">
      {commits.map(({ commit, paths, subject }) => (
        <ThreadCheckpointCommitCard
          key={commit}
          paths={paths}
          sourceItemId={`intersecting-commit:${commit}`}
          state={{ status: "summary", summary: { committedSha: commit, description: "", title: subject || "No commit subject", totals: null } }}
        />
      ))}
    </div>
  );
}
