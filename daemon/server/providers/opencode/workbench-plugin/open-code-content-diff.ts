/*
 * Exports:
 * - diffGitContents: compare captured text with `git diff --no-index`, spawned directly from the OpenCode process.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "../../../lib/workbench/WorkbenchTemporaryDirectory";

const execGit = promisify(execFile);

interface ExecFailure { code: number; stdout: string; stderr: string }

const isExecFailure = (error: unknown): error is ExecFailure => error instanceof Error
  && "code" in error && typeof error.code === "number"
  && "stdout" in error && typeof error.stdout === "string"
  && "stderr" in error && typeof error.stderr === "string";

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
      const result = await execGit(
        "git",
        ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "before", "after"],
        { cwd: directory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) },
      );
      if (result.stderr.trim()) throw new Error("Git content comparison reported diagnostic output.");
      return result.stdout;
    } catch (error) {
      // --no-index returns 1 for an ordinary difference, not an execution failure.
      if (!options.signal?.aborted && isExecFailure(error) && error.code === 1) {
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
