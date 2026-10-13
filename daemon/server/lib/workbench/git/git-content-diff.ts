/*
 * Exports:
 * - diffGitContents: compare captured text without mutating repository state.
 */
import fs from "node:fs/promises";
import path from "node:path";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import { gitProcesses, GitProcessError } from "./GitProcessHost";

export async function diffGitContents(before: string, after: string, options: {
  signal?: AbortSignal;
  temporaryRoot?: string;
} = {}): Promise<string> {
  options.signal?.throwIfAborted();
  if (before === after) return "";
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-content-diff-", options.temporaryRoot);
  const directory = temporary.path;
  let failure: Error | undefined;
  try {
    await Promise.all([
      fs.writeFile(path.join(directory, "before"), before, { signal: options.signal }),
      fs.writeFile(path.join(directory, "after"), after, { signal: options.signal }),
    ]);
    options.signal?.throwIfAborted();
    try {
      const result = await gitProcesses.run({
        args: ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "before", "after"],
        cwd: directory, maxBuffer: 32 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}),
      });
      if (result.stderr.trim()) throw new Error("Git content comparison reported diagnostic output.");
      return result.stdout.toString("utf8");
    } catch (error) {
      // --no-index returns 1 for an ordinary difference, not an execution failure.
      if (!options.signal?.aborted && error instanceof GitProcessError && error.code === 1) {
        if (error.stderr.trim()) throw new Error("Git content comparison reported diagnostic output.", { cause: error });
        return error.stdout;
      }
      throw error;
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Git content comparison failed.", { cause: error });
    throw failure;
  } finally {
    try {
      await temporary.dispose();
    } catch (error) {
      throw new AggregateError([...(failure ? [failure] : []), error], "Git content comparison cleanup failed.");
    }
  }
}
