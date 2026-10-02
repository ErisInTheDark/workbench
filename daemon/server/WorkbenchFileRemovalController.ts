/*
 * Exports:
 * - WorkbenchFileRemovalClaimCheck: active-claim policy port for one managed caller.
 * - default WorkbenchFileRemovalController: validate, claim-check, then delete wb rm targets.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { WorkbenchFileRemovalExecutionRequestSchema } from "./lib/workbench/commands/file-removal-command-definition";

export type WorkbenchFileRemovalClaimCheck = (
  request: { cwd: string; harness: string; threadId: string; paths: string[] },
  signal: AbortSignal,
) => Promise<{ allowed: boolean; uncoveredPaths: string[] }>;

interface RemovalTarget {
  absolute: string;
  directory: boolean;
  requested: string;
}

function comparable(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function isSameOrAncestor(candidate: string, descendant: string) {
  const relative = path.relative(comparable(candidate), comparable(descendant));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function text(status: number, lines: readonly string[]) {
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    status,
  });
}

export default class WorkbenchFileRemovalController {
  constructor(private readonly checkClaims: WorkbenchFileRemovalClaimCheck) {}

  async execute(body: object, signal: AbortSignal) {
    const parsed = WorkbenchFileRemovalExecutionRequestSchema.safeParse(body);
    if (!parsed.success) return text(400, ["A valid wb rm request is required."]);
    const request = parsed.data;
    const cwd = path.resolve(request.cwd);
    const targets = new Map<string, Omit<RemovalTarget, "directory">>();
    for (const requested of request.paths) {
      const absolute = path.resolve(cwd, requested);
      targets.set(comparable(absolute), { absolute, requested });
    }

    const rejections: string[] = [];
    const resolved: RemovalTarget[] = [];
    for (const target of targets.values()) {
      if (isSameOrAncestor(target.absolute, cwd)) {
        rejections.push(`Refusing to delete the working directory or its ancestor: ${target.requested}`);
        continue;
      }
      try {
        const directory = (await fs.lstat(target.absolute)).isDirectory();
        if (directory && !request.recursive) rejections.push(`Directory requires recursive: ${target.requested}`);
        else resolved.push({ ...target, directory });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        rejections.push(`Path does not exist: ${target.requested}`);
      }
    }
    if (rejections.length) return text(400, [...rejections, "Nothing was deleted."]);

    signal.throwIfAborted();
    const claims = await this.checkClaims({
      cwd, harness: request.harness, threadId: request.threadId, paths: resolved.map(({ absolute }) => absolute),
    }, signal);
    if (!claims.allowed) {
      return text(400, [`Unclaimed paths: ${claims.uncoveredPaths.join(", ")}. Claim every path before deleting. Nothing was deleted.`]);
    }

    signal.throwIfAborted();
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const target of resolved) {
      try {
        await fs.rm(target.absolute, { force: false, recursive: target.directory });
        deleted.push(target.requested);
      } catch (error) {
        failed.push(`${target.requested}: ${errorMessage(error)}`);
      }
    }
    if (failed.length) {
      return text(500, [
        ...(deleted.length ? ["Deleted:", ...deleted.map(entry => `  ${entry}`)] : ["Nothing was deleted."]),
        "Failed:", ...failed.map(entry => `  ${entry}`),
      ]);
    }
    return text(200, deleted.map(entry => `Deleted ${entry}`));
  }
}
