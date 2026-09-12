/*
 * Exports:
 * - default parseGitFileChangeOutput: decode combined NUL-delimited Git metadata and exact patches, identifying gitlinks for separate inspection.
 */
import type { GitCheckpointFileChange } from "workbench-shared/workbench/git/checkpoint-contracts";

type GitFileChangeOutput =
  | { kind: "changes"; changes: GitCheckpointFileChange[] }
  | { kind: "gitlinks"; paths: string[] };

export default function parseGitFileChangeOutput(output: string): GitFileChangeOutput {
  if (!output) return { kind: "changes", changes: [] };
  let offset = 0;
  const field = () => {
    const end = output.indexOf("\0", offset);
    if (end < 0) throw new Error("Git change metadata ended before its field separator.");
    const value = output.slice(offset, end);
    offset = end + 1;
    return value;
  };
  const entries: Array<{ change: Omit<GitCheckpointFileChange, "diff">; gitlink: boolean }> = [];
  while (output[offset] === ":") {
    const raw = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/u.exec(field());
    if (!raw) throw new Error("Git returned invalid raw change metadata.");
    const filePath = field();
    if (!filePath) throw new Error("Git returned an empty changed path.");
    entries.push({
      change: {
        additions: 0,
        deletions: 0,
        kind: raw[3] === "A" ? { type: "add" } : raw[3] === "D"
          ? { type: "delete" } : { type: "update", move_path: null },
        path: filePath,
      },
      gitlink: raw[1] === "160000" || raw[2] === "160000",
    });
  }
  if (!entries.length) throw new Error("Git returned changes without raw metadata.");
  for (const { change } of entries) {
    const numstat = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/u.exec(field());
    if (!numstat || numstat[3] !== change.path) throw new Error("Git change counts do not match the raw paths.");
    change.additions = numstat[1] === "-" ? 0 : Number(numstat[1]);
    change.deletions = numstat[2] === "-" ? 0 : Number(numstat[2]);
  }
  if (field() !== "") throw new Error("Git returned an invalid patch separator.");
  // Expanded submodule diffs can contain nested patch headers.
  if (entries.some(({ gitlink }) => gitlink)) {
    return { kind: "gitlinks", paths: entries.map(({ change }) => change.path) };
  }
  const patches = output.slice(offset);
  const headers = [...patches.matchAll(/^(?:\x1b\[[0-9;]*m)*diff --git /gm)].map((match) => ({
    boundary: match.index,
    start: match.index + match[0].indexOf("diff --git "),
  }));
  if (headers[0]?.boundary !== 0 || headers.length !== entries.length) throw new Error("Git patches do not match the raw change records.");
  return {
    kind: "changes",
    changes: entries.map(({ change }, index) => ({
      ...change,
      diff: patches.slice(headers[index].start, headers[index + 1]?.boundary ?? patches.length),
    })),
  };
}
