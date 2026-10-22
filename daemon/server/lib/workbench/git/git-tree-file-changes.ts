/*
 * Exports:
 * - listTreeFileChanges: every changed file between two trees with blobs, modes, line counts and a content identity.
 */
import type { GitObjectFile } from "workbench-shared/workbench/git/git-object-contracts";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

const zeroToNull = (value: string) => /^0+$/u.test(value) ? null : value;

/** Renames are detected; the identity changes whenever either side's path, mode or content does. */
export async function listTreeFileChanges(git: WorkbenchGitRepository, base: string, tree: string): Promise<GitObjectFile[]> {
  const raw = (await git.run(["diff", "--raw", "--no-abbrev", "-z", "-M", base, tree])).split("\0");
  const counts = (await git.run(["diff", "--numstat", "-z", "-M", base, tree])).split("\0");
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (let i = 0; i < counts.length && counts[i]; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(counts[i]!);
    if (!match) throw new Error("Invalid Git change counts.");
    let name = match[3]!;
    if (!name) { i++; name = counts[++i]!; }
    stats.set(name, {
      additions: match[1] === "-" ? null : Number(match[1]),
      deletions: match[2] === "-" ? null : Number(match[2]),
    });
  }
  const files: GitObjectFile[] = [];
  for (let i = 0; i < raw.length && raw[i]; i++) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([AMDRT])\d*$/u.exec(raw[i]!);
    if (!match) throw new Error("Unsupported Git change metadata.");
    const oldName = raw[++i]!;
    const status = match[5] as GitObjectFile["status"];
    const name = status === "R" ? raw[++i]! : oldName;
    const count = stats.get(name);
    if (!count) throw new Error("Git change counts are missing.");
    const baseBlob = zeroToNull(match[3]!);
    const blob = zeroToNull(match[4]!);
    const baseMode = match[1]!;
    const mode = match[2]!;
    files.push({
      path: name, oldPath: status === "R" ? oldName : null, status,
      baseBlob, blob, baseMode, mode, ...count, binary: count.additions === null,
      identity: `${oldName}\0${name}\0${baseMode}:${baseBlob}:${mode}:${blob}`,
    });
  }
  return files;
}
