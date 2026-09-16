/*
 * Exports:
 * - ThreadGitSelectionScope: canonical thread and validated target worktree.
 * - ThreadGitSelectionCommand: scoped selection, claim and commit outcome intents.
 * - ThreadGitSelectionResult: selection or claimed batch readback.
 * - default WorkbenchThreadGitSelectionStore: atomic selection ownership and bounded legacy import.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { workbenchLibraryRoot } from "../../lib/workbench-library-paths.ts";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";

export interface ThreadGitSelectionScope {
  threadId: string;
  worktreeRoot: string;
}
export type ThreadGitSelectionCommand =
  | { kind: "add" | "unstage"; scope: ThreadGitSelectionScope; paths: readonly string[] }
  | { kind: "claim"; scope: ThreadGitSelectionScope }
  | { kind: "settle"; scope: ThreadGitSelectionScope; batchId: string; outcome: "committed" | "failed" };
export type ThreadGitSelectionResult =
  | { kind: "selection"; changedPaths: string[]; selectedPaths: string[] }
  | { kind: "claimed"; batchId: string; selectedPaths: string[] }
  | { kind: "settled" };

const markerSchema = z.object({ version: z.literal(1), path: z.string().min(1) });
const STALE_BATCH_AGE_MS = 5 * 60 * 1000;

function validatePath(value: string) {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value) || value.split("/").some(part => part === "..")) {
    throw new Error("Thread Git selection path must stay inside its worktree.");
  }
  return value;
}

export default class WorkbenchThreadGitSelectionStore {
  constructor(
    private readonly database: Database.Database,
    private readonly legacyRoot = workbenchLibraryRoot,
    private readonly now = Date.now,
  ) {}

  execute(command: ThreadGitSelectionCommand): ThreadGitSelectionResult {
    if (!path.isAbsolute(command.scope.worktreeRoot)) throw new Error("Thread Git worktree must be absolute.");
    return this.database.transaction((): ThreadGitSelectionResult => {
      const identity = new WorkbenchThreadIdentityRepository(this.database).resolve({
        threadId: ThreadReferenceSchema.parse(command.scope.threadId),
      });
      if (!identity) throw new Error("Thread Git owner has not been admitted.");
      const scope = { threadId: identity.threadId, worktreeRoot: path.resolve(command.scope.worktreeRoot) };
      this.#importLegacy(scope, identity.bindings.map(binding => binding.nativeThreadId));
      if (command.kind !== "settle") {
        const stale = this.database.prepare(`SELECT id FROM workbench_thread_git_batches
          WHERE thread_id = ? AND worktree_root = ? AND claimed_at <= ?`)
          .all(scope.threadId, scope.worktreeRoot, this.now() - STALE_BATCH_AGE_MS) as Array<{ id: string }>;
        for (const { id } of stale) this.#settle(scope, id, "failed");
      }
      if (command.kind === "claim") {
        const selectedPaths = this.#selected(scope);
        if (!selectedPaths.length) throw new Error("This thread has no selected files to commit.");
        const batchId = this.#batch(scope, selectedPaths, this.now());
        this.database.prepare("DELETE FROM workbench_thread_git_selections WHERE thread_id = ? AND worktree_root = ?")
          .run(scope.threadId, scope.worktreeRoot);
        return { kind: "claimed", batchId, selectedPaths };
      }
      if (command.kind === "settle") {
        this.#settle(scope, command.batchId, command.outcome);
        return { kind: "settled" };
      }
      const requested = [...new Set(command.paths.map(validatePath))];
      const changedPaths = command.kind === "add" ? requested : this.#selected(scope).filter(selected => requested.some(request => {
        const left = process.platform === "win32" ? selected.toLowerCase() : selected;
        const right = process.platform === "win32" ? request.toLowerCase() : request;
        return request === "." || left === right || left.startsWith(`${right}/`);
      }));
      for (const filePath of changedPaths) {
        if (command.kind === "add") this.#select(scope, filePath);
        else this.database.prepare("DELETE FROM workbench_thread_git_selections WHERE thread_id = ? AND worktree_root = ? AND path = ?")
          .run(scope.threadId, scope.worktreeRoot, filePath);
      }
      return { kind: "selection", changedPaths: changedPaths.sort(), selectedPaths: this.#selected(scope) };
    })();
  }

  #selected(scope: ThreadGitSelectionScope) {
    return (this.database.prepare("SELECT path FROM workbench_thread_git_selections WHERE thread_id = ? AND worktree_root = ? ORDER BY path")
      .all(scope.threadId, scope.worktreeRoot) as Array<{ path: string }>).map(row => row.path);
  }

  #select(scope: ThreadGitSelectionScope, filePath: string) {
    this.database.prepare("INSERT OR IGNORE INTO workbench_thread_git_selections(thread_id, worktree_root, path) VALUES (?, ?, ?)")
      .run(scope.threadId, scope.worktreeRoot, validatePath(filePath));
  }

  #batch(scope: ThreadGitSelectionScope, paths: readonly string[], claimedAt: number) {
    const id = randomUUID();
    this.database.prepare("INSERT INTO workbench_thread_git_batches(id, thread_id, worktree_root, claimed_at) VALUES (?, ?, ?, ?)")
      .run(id, scope.threadId, scope.worktreeRoot, claimedAt);
    const insert = this.database.prepare("INSERT OR IGNORE INTO workbench_thread_git_batch_paths(batch_id, path) VALUES (?, ?)");
    for (const filePath of paths) insert.run(id, validatePath(filePath));
    return id;
  }

  #settle(scope: ThreadGitSelectionScope, batchId: string, outcome: "committed" | "failed") {
    const batch = this.database.prepare("SELECT thread_id, worktree_root FROM workbench_thread_git_batches WHERE id = ?")
      .get(batchId) as { thread_id: string; worktree_root: string } | undefined;
    if (!batch) return; // The existing stale-batch policy may already have restored it.
    if (batch.thread_id !== scope.threadId || batch.worktree_root !== scope.worktreeRoot) throw new Error("Thread Git batch belongs to another owner.");
    if (outcome === "failed") {
      this.database.prepare(`INSERT OR IGNORE INTO workbench_thread_git_selections(thread_id, worktree_root, path)
        SELECT ?, ?, path FROM workbench_thread_git_batch_paths WHERE batch_id = ?`).run(scope.threadId, scope.worktreeRoot, batchId);
    }
    this.database.prepare("DELETE FROM workbench_thread_git_batches WHERE id = ?").run(batchId);
  }

  #importLegacy(scope: ThreadGitSelectionScope, nativeThreadIds: readonly string[]) {
    const worktreeHash = createHash("sha256").update(scope.worktreeRoot).digest("hex");
    for (const nativeThreadId of new Set(nativeThreadIds)) {
      const normalized = nativeThreadId.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "thread";
      const hash = createHash("sha256").update(nativeThreadId).digest("hex").slice(0, 12);
      const source = path.join(this.legacyRoot, ".state/thread-git/worktrees", worktreeHash, "threads", `${normalized.slice(0, 80)}-${hash}`);
      if (this.database.prepare("SELECT 1 FROM workbench_external_storage_imports WHERE source_kind = 'thread-git-selection' AND source_scope = ?").get(source)) continue;
      for (const filePath of this.#legacyPaths(path.join(source, "selected"))) this.#select(scope, filePath);
      const transactions = path.join(source, "transactions");
      for (const entry of this.#entries(transactions)) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(transactions, entry.name);
        const paths = this.#legacyPaths(directory);
        if (paths.length) this.#batch(scope, paths, statSync(directory).mtimeMs);
      }
      this.database.prepare("INSERT INTO workbench_external_storage_imports(source_kind, source_scope, imported_at) VALUES ('thread-git-selection', ?, ?)")
        .run(source, this.now());
    }
  }

  #legacyPaths(directory: string) {
    return this.#entries(directory).filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => validatePath(markerSchema.parse(JSON.parse(readFileSync(path.join(directory, entry.name), "utf8"))).path));
  }

  #entries(directory: string) {
    try { return readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
