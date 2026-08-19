/*
 * Exports:
 * - default GitArcPathMover: resolve, validate, and apply one bounded stateless arc move batch with immediate rollback. Keywords: git, arc, move, filesystem, rollback.
 * - GitArcResolvedMove/GitArcResolvedMoveBatch/MAX_GIT_ARC_MOVE_MAPPINGS: typed bounded move evidence. Keywords: git, arc, move, mapping, limit.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { GitArcMoveRequest } from "./checkpoint-contracts";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

export const MAX_GIT_ARC_MOVE_MAPPINGS = 200;

export interface GitArcResolvedMove {
  destination: string;
  source: string;
}

export interface GitArcResolvedMoveBatch {
  mappings: GitArcResolvedMove[];
  matchedPathCount: number;
  remainingMatchCount: number;
}

const REGEX_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  try {
    const expression = new RegExp(workerData.pattern, "u");
    const mappings = [];
    let matchedPathCount = 0;
    for (const source of workerData.paths) {
      if (!expression.test(source)) continue;
      matchedPathCount += 1;
      if (mappings.length < workerData.limit) {
        mappings.push({ source, destination: source.replace(expression, workerData.replacement) });
      }
    }
    parentPort.postMessage({ mappings, matchedPathCount });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
`;

function pathsOverlap(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function canonicalPath(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function pathKind(absolutePath: string) {
  try {
    const stats = await fs.lstat(absolutePath);
    return stats.isDirectory() ? "directory" as const : "entry" as const;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export default class GitArcPathMover {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly regexTimeoutMs = 2_000,
  ) {}

  async resolve(move: GitArcMoveRequest): Promise<GitArcResolvedMoveBatch> {
    let batch: GitArcResolvedMoveBatch;
    if (move.kind === "maps") {
      batch = { mappings: move.mappings, matchedPathCount: move.mappings.length, remainingMatchCount: 0 };
    } else if (move.kind === "operands") {
      batch = await this.resolveOperands(move.operands);
    } else {
      batch = await this.resolveRegex(move.pattern, move.replacement, move.roots);
    }
    const mappings = batch.mappings.map(({ destination, source }) => ({
      destination: this.repository.normalizePaths([destination])[0]!,
      source: this.repository.normalizePaths([source])[0]!,
    }));
    await this.validate(mappings);
    return { ...batch, mappings };
  }

  async apply(mappings: readonly GitArcResolvedMove[], publish: () => Promise<void>) {
    const completed: GitArcResolvedMove[] = [];
    const createdDirectories: string[] = [];
    try {
      for (const mapping of mappings) {
        await this.ensureDestinationParent(mapping.destination, createdDirectories);
        await this.rename(mapping.source, mapping.destination);
        completed.push(mapping);
      }
      await publish();
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const mapping of [...completed].reverse()) {
        try {
          await this.rename(mapping.destination, mapping.source);
        } catch (rollbackError) {
          rollbackErrors.push(`${mapping.destination} -> ${mapping.source}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      for (const directory of [...createdDirectories].reverse()) {
        try {
          await fs.rmdir(directory);
        } catch (cleanupError) {
          if (!(["ENOENT", "ENOTEMPTY"] as Array<string | undefined>).includes((cleanupError as NodeJS.ErrnoException).code)) {
            rollbackErrors.push(`remove ${directory}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }
      }
      if (rollbackErrors.length) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} Rollback also failed: ${rollbackErrors.join("; ")}`);
      }
      throw error;
    }
  }

  private async ensureDestinationParent(destination: string, createdDirectories: string[]) {
    const parent = path.dirname(this.repository.resolvePath(destination));
    const missing: string[] = [];
    let cursor = parent;
    while (cursor !== this.repository.root && await pathKind(cursor) === null) {
      missing.push(cursor);
      cursor = path.dirname(cursor);
    }
    await fs.mkdir(parent, { recursive: true });
    createdDirectories.push(...missing.reverse());
  }

  private async rename(source: string, destination: string) {
    const sourcePath = this.repository.resolvePath(source);
    const destinationPath = this.repository.resolvePath(destination);
    if (source !== destination && canonicalPath(source) === canonicalPath(destination)) {
      const temporaryPath = path.join(path.dirname(sourcePath), `.workbench-arc-mv-${randomUUID()}`);
      await fs.rename(sourcePath, temporaryPath);
      try {
        await fs.rename(temporaryPath, destinationPath);
      } catch (error) {
        await fs.rename(temporaryPath, sourcePath);
        throw error;
      }
      return;
    }
    await fs.rename(sourcePath, destinationPath);
  }

  private async resolveOperands(operands: string[]): Promise<GitArcResolvedMoveBatch> {
    const normalized = operands.map((operand) => this.repository.normalizePaths([operand])[0]!);
    const sources = normalized.slice(0, -1);
    const requestedDestination = normalized.at(-1)!;
    if (sources.length > MAX_GIT_ARC_MOVE_MAPPINGS) {
      throw new Error(`Arc mv accepts at most ${MAX_GIT_ARC_MOVE_MAPPINGS} mappings per command.`);
    }
    const destinationKind = await pathKind(this.repository.resolvePath(requestedDestination));
    if (sources.length > 1 && destinationKind !== "directory") {
      throw new Error("Arc mv with multiple sources requires an existing destination directory.");
    }
    const mappings = sources.map((source) => ({
      destination: destinationKind === "directory"
        ? `${requestedDestination}/${path.posix.basename(source)}`
        : requestedDestination,
      source,
    }));
    return { mappings, matchedPathCount: mappings.length, remainingMatchCount: 0 };
  }

  private async resolveRegex(pattern: string, replacement: string, roots: string[]): Promise<GitArcResolvedMoveBatch> {
    const normalizedRoots = roots.map((root) => {
      const trimmed = root.trim();
      return trimmed === "." ? "." : this.repository.normalizePaths([trimmed])[0]!;
    });
    const paths = (await this.repository.run([
      "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...normalizedRoots,
    ])).split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right));
    const result = await this.evaluateRegex(paths, pattern, replacement);
    return {
      mappings: result.mappings,
      matchedPathCount: result.matchedPathCount,
      remainingMatchCount: Math.max(0, result.matchedPathCount - result.mappings.length),
    };
  }

  private async evaluateRegex(paths: string[], pattern: string, replacement: string) {
    return await new Promise<{ mappings: GitArcResolvedMove[]; matchedPathCount: number }>((resolve, reject) => {
      const worker = new Worker(REGEX_WORKER_SOURCE, {
        eval: true,
        workerData: { limit: MAX_GIT_ARC_MOVE_MAPPINGS, paths, pattern, replacement },
      });
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error(`Arc mv regex evaluation exceeded ${this.regexTimeoutMs}ms.`));
      }, this.regexTimeoutMs);
      worker.once("message", (message: { error?: string; mappings?: GitArcResolvedMove[]; matchedPathCount?: number }) => {
        clearTimeout(timeout);
        void worker.terminate();
        if (message.error) reject(new Error(`Invalid arc mv regex: ${message.error}`));
        else resolve({ mappings: message.mappings ?? [], matchedPathCount: message.matchedPathCount ?? 0 });
      });
      worker.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private async validate(mappings: readonly GitArcResolvedMove[]) {
    if (!mappings.length) throw new Error("Arc mv did not resolve any paths to move.");
    if (mappings.length > MAX_GIT_ARC_MOVE_MAPPINGS) {
      throw new Error(`Arc mv accepts at most ${MAX_GIT_ARC_MOVE_MAPPINGS} mappings per command.`);
    }
    const sourceKeys = new Set<string>();
    const destinationKeys = new Set<string>();
    for (const mapping of mappings) {
      const sourceKey = canonicalPath(mapping.source);
      const destinationKey = canonicalPath(mapping.destination);
      if (sourceKey === destinationKey && mapping.source === mapping.destination) {
        throw new Error(`Arc mv source and destination are identical: ${mapping.source}`);
      }
      if (sourceKeys.has(sourceKey)) throw new Error(`Arc mv source is repeated: ${mapping.source}`);
      if (destinationKeys.has(destinationKey)) throw new Error(`Arc mv destination is repeated: ${mapping.destination}`);
      sourceKeys.add(sourceKey);
      destinationKeys.add(destinationKey);
    }
    for (let index = 0; index < mappings.length; index += 1) {
      const mapping = mappings[index]!;
      const sourceKind = await pathKind(this.repository.resolvePath(mapping.source));
      if (!sourceKind) throw new Error(`Arc mv source does not exist: ${mapping.source}`);
      for (const other of mappings.slice(index + 1)) {
        if (pathsOverlap(mapping.source, other.source)) {
          throw new Error(`Arc mv sources overlap: ${mapping.source} <> ${other.source}`);
        }
      }
      if (mapping.destination.startsWith(`${mapping.source}/`)) {
        throw new Error(`Arc mv destination is inside its source: ${mapping.source} -> ${mapping.destination}`);
      }
      const destinationKind = await pathKind(this.repository.resolvePath(mapping.destination));
      const caseOnlyMove = canonicalPath(mapping.source) === canonicalPath(mapping.destination);
      if (destinationKind && !caseOnlyMove) {
        throw new Error(`Arc mv destination already exists: ${mapping.destination}`);
      }
    }
  }
}
