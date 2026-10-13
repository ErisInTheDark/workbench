/*
 * Exports:
 * - default watchGitRefs: watch a checkout's HEAD, index, config, packed-refs and selected loose ref trees for changes.
 * - GitRefWatchDirectories: the per-worktree and common Git directories one watch spans.
 */
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface GitRefWatchDirectories {
  gitDir: string;
  commonDir: string;
}

const ROOT_FILES = new Set(["HEAD", "index", "config", "packed-refs"]);

/** Watches only small ref trees, never object storage or the checkout. Returns the stop function. */
export default async function watchGitRefs(
  { gitDir, commonDir }: GitRefWatchDirectories,
  refTrees: readonly ("heads" | "remotes")[],
  changed: () => void,
  warn: (error: Error) => void,
) {
  const stops: Array<() => void> = [];
  const attach = (directory: string, recursive: boolean) => {
    const watcher = watch(directory, { recursive }, (_event, filename) => {
      if (recursive || !filename || ROOT_FILES.has(filename.toString())) changed();
    });
    watcher.on("error", warn);
    stops.push(() => watcher.close());
  };
  try {
    for (const directory of new Set([gitDir, commonDir])) attach(directory, false);
    for (const tree of refTrees) {
      const directory = path.join(commonDir, "refs", tree);
      // Git tolerates empty ref directories; creating one lets the watch start before the first ref lands.
      await fs.mkdir(directory, { recursive: true });
      attach(directory, true);
    }
  } catch (error) {
    for (const stop of stops) stop();
    throw error;
  }
  return () => { for (const stop of stops) stop(); };
}
