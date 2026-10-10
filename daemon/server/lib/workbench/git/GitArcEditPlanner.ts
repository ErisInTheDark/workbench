/*
 * Exports:
 * - GitArcEditWorkerMessage/GitArcEditRunner/runGitArcEditWorker: run operations off the event loop, cancelled by the caller's signal.
 * - GitArcEditPlan: base, moved-only and target trees plus exact expected and written file states.
 * - normalizeGitArcEditOperations: resolve root-relative operation paths to repository-relative ones.
 * - readGitArcEditPatchLines/selectGitArcEditHunks: changed new-side line numbers and line-scoped hunks of one patch.
 * - default GitArcEditPlanner: snapshot candidate files, run operations, and build session trees and presentation rows.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { GitArcEditFile, GitArcEditOperation } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import {
  createGitArcEditPathFilter,
  underGitArcEditRoots,
  type GitArcEditWorkInput,
  type GitArcEditWorkResult,
} from "./git-arc-edit-operations";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitTreeFile } from "./WorkbenchGitRepository";

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

export type GitArcEditWorkerMessage =
  | { kind: "completed"; result: GitArcEditWorkResult }
  | { kind: "failed"; message: string };

export type GitArcEditRunner = (input: GitArcEditWorkInput, signal?: AbortSignal) => Promise<GitArcEditWorkResult>;

export interface GitArcEditPlan {
  base: string;
  /** Touched path -> file the worktree must still hold before writing; null where no file may exist. */
  expected: Map<string, GitTreeFile | null>;
  files: GitArcEditFile[];
  ignoredPaths: string[];
  moved: string;
  skippedFileCount: number;
  target: string;
  touchedPaths: string[];
  visiblePaths: string[];
  warnings: string[];
  /** Touched path -> file to write, or null to remove. */
  writes: Map<string, GitTreeFile | null>;
}

interface SnapshotFile {
  bytes: Buffer | null;
  ignored: boolean;
  mode: string;
  symlink: boolean;
  text: string | null;
}

const WORKER_URL = new URL("./git-arc-edit-worker-bootstrap.mjs", import.meta.url);

export function runGitArcEditWorker(input: GitArcEditWorkInput, signal?: AbortSignal) {
  return new Promise<GitArcEditWorkResult>((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(WORKER_URL, { workerData: input });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch((error: unknown) => console.error(`[git-arc-edit] worker termination failed: ${error instanceof Error ? error.message : String(error)}`));
      finish();
    };
    const onAbort = () => settle(() => reject(signal!.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: GitArcEditWorkerMessage) => settle(() => (
      message.kind === "completed" ? resolve(message.result) : reject(new Error(message.message))
    )));
    worker.once("error", error => settle(() => reject(error)));
    worker.once("exit", code => settle(() => reject(new Error(`Edit worker exited early with code ${code}.`))));
  });
}

function comparable(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizeGitArcEditOperations(repository: WorkbenchGitRepository, baseDirectory: string, operations: readonly GitArcEditOperation[]) {
  const relative = (value: string) => {
    const absolute = path.resolve(baseDirectory, value);
    return comparable(absolute) === comparable(repository.root) ? "." : repository.normalizePaths([absolute])[0]!;
  };
  return operations.map((operation): GitArcEditOperation => operation.kind === "replace"
    ? { ...operation, roots: operation.roots.map(relative) }
    : {
      ...operation,
      ...(operation.from !== undefined ? { from: relative(operation.from) } : {}),
      ...(operation.to !== undefined ? { to: relative(operation.to) } : {}),
      ...(operation.roots ? { roots: operation.roots.map(relative) } : {}),
      references: operation.references.map(spec => ({
        ...spec,
        aliases: Object.fromEntries(Object.entries(spec.aliases).map(([prefix, target]) => [prefix, relative(target)])),
        roots: spec.roots.map(relative),
      })),
    });
}

/** New-side line numbers each hunk adds or removes at, ascending and unique. */
export function readGitArcEditPatchLines(patch: string) {
  const lines = new Set<number>();
  let next = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      next = Number(header[1]);
      inHunk = true;
    } else if (!inHunk || line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("+")) {
      lines.add(next);
      next += 1;
    } else if (line.startsWith("-")) {
      lines.add(Math.max(next, 1));
    } else {
      next += 1;
    }
  }
  return [...lines].sort((left, right) => left - right);
}

/** The patch header with only the hunks whose new-side range covers `line`; the whole patch when none does. */
export function selectGitArcEditHunks(patch: string, line: number) {
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex(entry => HUNK_HEADER.test(entry));
  if (firstHunk < 0) return patch;
  const hunks: string[][] = [];
  for (const entry of lines.slice(firstHunk)) {
    if (HUNK_HEADER.test(entry)) hunks.push([entry]);
    else hunks.at(-1)!.push(entry);
  }
  const selected = hunks.filter(([header]) => {
    const match = HUNK_HEADER.exec(header!)!;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    return line >= start && line <= Math.max(start, start + count - 1);
  });
  return selected.length ? [...lines.slice(0, firstHunk), ...selected.flat()].join("\n") : patch;
}

function readScopes(operations: readonly GitArcEditOperation[]) {
  const moveScopes = operations.flatMap(operation => operation.kind !== "move" ? []
    : operation.from !== undefined ? [operation.from] : operation.roots!);
  const readers = operations.flatMap(operation => (operation.kind === "replace" ? [operation] : operation.references)
    .map(({ globs, roots }) => ({ filter: createGitArcEditPathFilter(globs), roots })));
  const ignoredScopes = operations.flatMap(operation => operation.kind === "replace"
    ? operation.includeIgnored ? operation.roots : []
    : [
      ...operation.from !== undefined ? [operation.from] : operation.includeIgnored ? operation.roots! : [],
      ...operation.references.flatMap(spec => spec.includeIgnored ? spec.roots : []),
    ]);
  return {
    ignoredScopes: [...new Set(ignoredScopes)],
    isMoveCandidate: (filePath: string) => underGitArcEditRoots(filePath, moveScopes),
    isTextCandidate: (filePath: string) => readers.some(({ filter, roots }) => underGitArcEditRoots(filePath, roots) && filter(filePath)),
  };
}

export default class GitArcEditPlanner {
  constructor(private readonly run: GitArcEditRunner = runGitArcEditWorker) {}

  async plan(repository: WorkbenchGitRepository, operations: GitArcEditOperation[], signal?: AbortSignal): Promise<GitArcEditPlan> {
    const scopes = readScopes(operations);
    const [visible, ignored] = await Promise.all([
      repository.listWorktreePaths(["."]),
      scopes.ignoredScopes.length ? repository.listIgnoredWorktreePaths(scopes.ignoredScopes) : Promise.resolve([]),
    ]);
    const ignoredSet = new Set(ignored);
    let skippedFileCount = 0;
    const snapshot = new Map<string, SnapshotFile>();
    await Promise.all([...new Set([...visible, ...ignored])].map(async (filePath) => {
      const absolute = repository.resolvePath(filePath);
      let stat;
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        // Tracked files deleted from the worktree are listed but no longer exist.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const file: SnapshotFile = {
        bytes: null,
        ignored: ignoredSet.has(filePath),
        mode: process.platform !== "win32" && stat.mode & 0o111 ? "100755" : "100644",
        symlink: stat.isSymbolicLink(),
        text: null,
      };
      snapshot.set(filePath, file);
      const moveCandidate = scopes.isMoveCandidate(filePath);
      const textCandidate = scopes.isTextCandidate(filePath) || moveCandidate;
      if (file.symlink || !stat.isFile() || !textCandidate) return;
      if (stat.size > MAX_TEXT_BYTES && !moveCandidate) {
        skippedFileCount += 1;
        return;
      }
      file.bytes = await fs.readFile(absolute);
      if (file.bytes.length > MAX_TEXT_BYTES || file.bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        skippedFileCount += 1;
        return;
      }
      const text = file.bytes.toString("utf8");
      if (Buffer.from(text, "utf8").equals(file.bytes)) file.text = text;
      else skippedFileCount += 1;
    }));
    signal?.throwIfAborted();

    const result = await this.run({
      caseInsensitive: process.platform === "win32" || process.platform === "darwin",
      files: [...snapshot].map(([filePath, file]) => ({ ignored: file.ignored, path: filePath, text: file.text })),
      operations,
    }, signal);

    const originOf = new Map(result.changes.map(change => [change.path, change.origin]));
    const origins = new Set(result.changes.map(change => change.origin));
    const touchedPaths = [...new Set([...origins, ...originOf.keys()])].sort((left, right) => left.localeCompare(right));
    const fileAt = (origin: string): GitTreeFile => {
      const file = snapshot.get(origin);
      if (file?.symlink) throw new Error(`Edit sessions cannot move symbolic links: ${origin}`);
      if (!file?.bytes) throw new Error(`Edit session lost the contents of ${origin}.`);
      return { bytes: file.bytes, mode: file.mode };
    };
    const newPaths = [...originOf.keys()].filter(filePath => !snapshot.has(filePath));
    const ignoredDestinations = new Set(newPaths.length ? await repository.listIgnoredPaths(newPaths) : []);
    const ignoredPaths = touchedPaths.filter(filePath => snapshot.get(filePath)?.ignored || ignoredDestinations.has(filePath));
    const ignoredTouched = new Set(ignoredPaths);

    const baseFiles = new Map<string, GitTreeFile | null>();
    const movedFiles = new Map<string, GitTreeFile | null>();
    const writes = new Map<string, GitTreeFile | null>();
    const changesByPath = new Map(result.changes.map(change => [change.path, change]));
    for (const filePath of touchedPaths) {
      baseFiles.set(filePath, origins.has(filePath) ? fileAt(filePath) : null);
      const change = changesByPath.get(filePath);
      if (!change) {
        movedFiles.set(filePath, null);
        writes.set(filePath, null);
        continue;
      }
      const source = fileAt(change.origin);
      movedFiles.set(filePath, source);
      writes.set(filePath, change.text === undefined ? source : { bytes: Buffer.from(change.text, "utf8"), mode: source.mode });
    }
    const head = await repository.headOrNull();
    const [base, moved, target] = await Promise.all([
      repository.writeTreeWithFiles(head, baseFiles),
      repository.writeTreeWithFiles(head, movedFiles),
      repository.writeTreeWithFiles(head, writes),
    ]);
    const finalPaths = [...originOf.keys()].sort((left, right) => left.localeCompare(right));
    const patches = new Map((finalPaths.length ? await repository.buildFileChanges(moved, target, finalPaths, signal) : [])
      .map(change => [change.path, change]));
    const files = finalPaths.map((filePath): GitArcEditFile => {
      const origin = originOf.get(filePath)!;
      const patch = patches.get(filePath);
      return {
        additions: patch?.additions ?? 0,
        binary: snapshot.get(origin)?.text === null,
        deletions: patch?.deletions ?? 0,
        ignored: ignoredTouched.has(filePath) || ignoredTouched.has(origin),
        lines: patch ? readGitArcEditPatchLines(patch.diff) : [],
        ...(origin !== filePath ? { movedFrom: origin } : {}),
        path: filePath,
      };
    });
    return {
      base,
      expected: baseFiles,
      files,
      ignoredPaths,
      moved,
      skippedFileCount,
      target,
      touchedPaths,
      visiblePaths: touchedPaths.filter(filePath => !ignoredTouched.has(filePath)),
      warnings: result.warnings,
      writes,
    };
  }
}
