/*
 * Exports:
 * - diffGitContents: compare captured text without mutating repository state.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function diffGitContents(before: string, after: string, options: {
  signal?: AbortSignal;
  temporaryRoot?: string;
} = {}): Promise<string> {
  options.signal?.throwIfAborted();
  if (before === after) return "";
  const directory = await fs.mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "workbench-content-diff-"));
  let failure: Error | undefined;
  try {
    await Promise.all([
      fs.writeFile(path.join(directory, "before"), before, { signal: options.signal }),
      fs.writeFile(path.join(directory, "after"), after, { signal: options.signal }),
    ]);
    options.signal?.throwIfAborted();
    try {
      const result = await execute("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color",
        "--", "before", "after"], {
        cwd: directory, windowsHide: true, signal: options.signal, maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      });
      if (result.stderr.trim()) throw new Error("Git content comparison reported diagnostic output.");
      return result.stdout;
    } catch (error) {
      // --no-index returns 1 for an ordinary difference, not an execution failure.
      if (!options.signal?.aborted && error instanceof Error && "code" in error && error.code === 1
        && "stdout" in error && typeof error.stdout === "string") {
        if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
          throw new Error("Git content comparison reported diagnostic output.", { cause: error });
        }
        return error.stdout;
      }
      throw error;
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Git content comparison failed.", { cause: error });
    throw failure;
  } finally {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch (error) {
      throw new AggregateError([...(failure ? [failure] : []), error], "Git content comparison cleanup failed.");
    }
  }
}
