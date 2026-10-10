/*
 * Exports:
 * - GitArcEditOwner: thread identity plus the workspace root directory an edit session resolves paths against.
 * - GitArcEditArcPort: active-arc facts and claim publication borrowed from the checkpoint controller.
 * - GitArcEditPendingCheck: absolute paths held by the caller's unsealed pending proposals.
 * - GitArcEditApplyAttempt: one apply attempt, blocked by sibling claims or applied.
 * - default GitArcEditSessionController: start, view, apply, revert and end one thread's edit session.
 */
import fs from "node:fs/promises";
import path from "node:path";

import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import {
  GIT_ARC_EDIT_PAGE_SIZE,
  type GitArcEditCollision,
  type GitArcEditOperation,
  type GitArcEditPhase,
  type GitArcEditResult,
} from "workbench-shared/workbench/git/git-arc-edit-contracts";
import type { GitArcHarness } from "workbench-shared/workbench/git/git-arc-storage";
import GitArcEditPlanner, { normalizeGitArcEditOperations, selectGitArcEditHunks, type GitArcEditPlan } from "./GitArcEditPlanner";
import GitArcEditSessionStore, { type GitArcEditSession, type GitArcEditSessionMetadata } from "./GitArcEditSessionStore";
import GitObjectReadSession from "./GitObjectReadSession";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";
import WorkbenchGitRepository, { type GitTreeFile } from "./WorkbenchGitRepository";

export interface GitArcEditOwner {
  /** Workspace root directory: relative operation and diff paths resolve against it. */
  cwd: string;
  harness: GitArcHarness;
  threadId: string;
}

type Identity = Pick<GitArcEditOwner, "harness" | "threadId"> & { cwd: string };

export interface GitArcEditArcPort {
  activeClaimPaths(identity: Identity): Promise<string[] | null>;
  findClaimCollisions(identity: Identity, paths: string[]): Promise<GitArcEditCollision[]>;
  /** Claim the paths into the caller's active arc; `write` changes the worktree and must call `publish`. */
  claimAndWrite(input: Identity & {
    claimPaths: string[];
    write: (publish: () => Promise<void>, additionalClaims: string[]) => Promise<void>;
  }): Promise<unknown>;
  releaseClaims(input: Identity & { paths: string[] }): Promise<unknown>;
}

export type GitArcEditPendingCheck = (absolutePaths: string[]) => Promise<string[]>;

export type GitArcEditApplyAttempt = { kind: "blocked" } | { kind: "applied"; result: GitArcEditResult };

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

async function readWorktreeFile(absolute: string): Promise<GitTreeFile | null | "other"> {
  try {
    const stat = await fs.lstat(absolute);
    if (!stat.isFile()) return "other";
    return {
      bytes: await fs.readFile(absolute),
      mode: process.platform !== "win32" && stat.mode & 0o111 ? "100755" : "100644",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pruneEmptyParents(root: string, directory: string) {
  for (let current = directory; path.relative(root, current) && !path.relative(root, current).startsWith(".."); current = path.dirname(current)) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST", "ENOENT", "ENOTDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
  }
}

async function putWorktreeFile(repository: WorkbenchGitRepository, filePath: string, file: GitTreeFile | null) {
  const absolute = repository.resolvePath(filePath);
  if (!file) {
    await fs.rm(absolute, { force: true });
    await pruneEmptyParents(repository.root, path.dirname(absolute));
    return;
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, file.bytes);
  if (process.platform !== "win32" && file.mode === "100755") await fs.chmod(absolute, 0o755);
}

/** Removals run before writes, so a moved file may take a path its source folder or case variant held. */
function writeOrder(writes: ReadonlyMap<string, GitTreeFile | null>) {
  return [...writes].sort(([leftPath, left], [rightPath, right]) => Number(left !== null) - Number(right !== null) || leftPath.localeCompare(rightPath));
}

/**
 * Writes exact files after proving the worktree still holds `expected`, and returns the rollback that restores it.
 * Any write failure restores what was already written before rethrowing.
 */
async function writeWorktreeFiles(
  repository: WorkbenchGitRepository,
  expected: ReadonlyMap<string, GitTreeFile | null>,
  writes: ReadonlyMap<string, GitTreeFile | null>,
) {
  const presentKeys = new Set([...expected].flatMap(([filePath, file]) => file ? [filePath.toLowerCase()] : []));
  for (const [filePath, file] of expected) {
    // A case-only rename's new path reads as its old one on case-insensitive filesystems.
    if (!file && caseInsensitive && presentKeys.has(filePath.toLowerCase())) continue;
    const current = await readWorktreeFile(repository.resolvePath(filePath));
    const matches = current === null ? file === null : current !== "other" && file !== null && current.bytes.equals(file.bytes);
    if (!matches) throw new Error(`${filePath} changed since the edit was planned. Run the command again to replan.`);
  }
  const written: string[] = [];
  const rollback = async () => {
    const failures: string[] = [];
    for (const [filePath, file] of writeOrder(new Map(written.map(entry => [entry, expected.get(entry) ?? null])))) {
      try {
        await putWorktreeFile(repository, filePath, file);
      } catch (error) {
        failures.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) throw new Error(`Edit rollback failed for ${failures.join("; ")}`);
  };
  try {
    for (const [filePath, file] of writeOrder(writes)) {
      written.push(filePath);
      await putWorktreeFile(repository, filePath, file);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Edit write failed and its rollback was incomplete.");
    }
    throw error;
  }
  return rollback;
}

function parseDiffTarget(value: string) {
  const match = /^(.*):(\d+)$/u.exec(value);
  return match && match[1] ? { line: Number(match[2]), path: match[1] } : { line: null, path: value };
}

export default class GitArcEditSessionController {
  constructor(
    private readonly arc: GitArcEditArcPort,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
    private readonly planner = new GitArcEditPlanner(),
  ) {}

  private async open(owner: GitArcEditOwner) {
    const repository = await WorkbenchGitRepository.open(owner.cwd);
    return { identity: { ...owner, cwd: repository.root }, repository, store: new GitArcEditSessionStore(repository, this.resolveThreadIdentity) };
  }

  private async requireSession(store: GitArcEditSessionStore, owner: GitArcEditOwner) {
    const session = await store.read(owner);
    if (!session) throw new Error("This thread has no edit session. Start one with wb git arc edit start.");
    return session;
  }

  private async blockers(repository: WorkbenchGitRepository, identity: Identity, plan: GitArcEditPlan, checkPending: GitArcEditPendingCheck) {
    if (!plan.visiblePaths.length) return { collisions: [], dirty: [], pending: [] };
    const [collisions, claimed, changed, pending] = await Promise.all([
      this.arc.findClaimCollisions(identity, plan.visiblePaths),
      this.arc.activeClaimPaths(identity),
      repository.listWorktreeChangedPaths(await repository.headOrNull(), plan.visiblePaths),
      checkPending(plan.visiblePaths.map(filePath => repository.resolvePath(filePath))),
    ]);
    const colliding = new Set(collisions.flatMap(({ paths }) => paths));
    const own = new GitArcPathSet(claimed ?? []);
    return {
      collisions,
      dirty: changed.filter(filePath => !own.covers(filePath) && !colliding.has(filePath)),
      pending: pending.map(absolute => path.relative(repository.root, absolute).replace(/\\/gu, "/")),
    };
  }

  private metadata(plan: GitArcEditPlan, operations: GitArcEditOperation[], rest: Partial<GitArcEditSessionMetadata> & Pick<GitArcEditSessionMetadata, "phase">): GitArcEditSessionMetadata {
    return {
      additionalClaims: [],
      files: plan.files,
      ignoredPaths: plan.ignoredPaths,
      kind: "workbench-arc-edit-session",
      operations,
      skippedFileCount: plan.skippedFileCount,
      touchedPaths: plan.touchedPaths,
      version: 1,
      warnings: plan.warnings,
      ...rest,
    };
  }

  private result(
    session: Pick<GitArcEditSession, "metadata" | "session">,
    phase: GitArcEditPhase,
    page: number,
    extra: Partial<GitArcEditResult> = {},
  ): GitArcEditResult {
    const { files } = session.metadata;
    const pageCount = Math.max(1, Math.ceil(files.length / GIT_ARC_EDIT_PAGE_SIZE));
    if (page > pageCount) throw new Error(`Page ${page} is past the last page (${pageCount}).`);
    return {
      additionalClaims: session.metadata.additionalClaims,
      additions: files.reduce((total, file) => total + file.additions, 0),
      blockedDirtyPaths: [],
      blockedPendingPaths: [],
      collisions: [],
      conflictedPaths: [],
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      diffs: [],
      fileCount: files.length,
      files: files.slice((page - 1) * GIT_ARC_EDIT_PAGE_SIZE, page * GIT_ARC_EDIT_PAGE_SIZE),
      ignoredFileCount: files.filter(file => file.ignored).length,
      ...(session.metadata.matchedPreview === undefined ? {} : { matchedPreview: session.metadata.matchedPreview }),
      page,
      pageCount,
      phase,
      releasedClaims: [],
      ...(session.metadata.rootId ? { rootId: session.metadata.rootId } : {}),
      session: session.session,
      skippedFileCount: session.metadata.skippedFileCount,
      warnings: session.metadata.warnings,
      ...extra,
    };
  }

  async start(input: {
    checkPending: GitArcEditPendingCheck;
    operations: GitArcEditOperation[];
    owner: GitArcEditOwner;
    rootId?: string;
    signal?: AbortSignal;
  }) {
    return await GitObjectReadSession.run(async () => {
      const { identity, repository, store } = await this.open(input.owner);
      const existing = await store.read(input.owner);
      if (existing?.metadata.phase === "applied") {
        throw new Error(`Edit session ${existing.session} is applied. Run wb git arc edit end or wb git arc edit revert first.`);
      }
      const operations = normalizeGitArcEditOperations(repository, input.owner.cwd, input.operations);
      const plan = await this.planner.plan(repository, operations, input.signal);
      if (!plan.files.length) throw new Error("The operations change no files.");
      const blockers = await this.blockers(repository, identity, plan, input.checkPending);
      const session = await store.publish(input.owner, await store.prepare(plan, this.metadata(plan, operations, {
        phase: "preview", ...(input.rootId ? { rootId: input.rootId } : {}),
      })), existing?.commit ?? null);
      return this.result(session, "preview", 1, {
        blockedDirtyPaths: blockers.dirty,
        blockedPendingPaths: blockers.pending,
        collisions: blockers.collisions,
      });
    });
  }

  async view(input: { diffs: string[]; owner: GitArcEditOwner; page: number }) {
    return await GitObjectReadSession.run(async () => {
      const { repository, store } = await this.open(input.owner);
      const session = await this.requireSession(store, input.owner);
      const byPath = new Map(session.metadata.files.flatMap(file => [[file.path, file], ...file.movedFrom ? [[file.movedFrom, file] as const] : []]));
      const targets = input.diffs.map((value) => {
        const target = parseDiffTarget(value);
        const [relative] = repository.normalizePaths([path.resolve(input.owner.cwd, target.path)]);
        const file = byPath.get(relative!);
        if (!file) throw new Error(`${target.path} is not part of edit session ${session.session}.`);
        return { file, line: target.line };
      });
      const patchPaths = [...new Set(targets.map(({ file }) => file.path))];
      const patches = new Map((patchPaths.length ? await repository.buildFileChanges(session.moved, session.target, patchPaths) : [])
        .map(change => [change.path, change.diff]));
      return this.result(session, session.metadata.phase, input.page, {
        diffs: targets.map(({ file, line }) => {
          const patch = patches.get(file.path);
          return {
            patch: patch ? line === null ? patch : selectGitArcEditHunks(patch, line)
              : `No content changes${file.movedFrom ? `; moved from ${file.movedFrom}` : ""}.`,
            path: file.path,
          };
        }),
      });
    });
  }

  async tryApply(input: { checkPending: GitArcEditPendingCheck; owner: GitArcEditOwner; signal?: AbortSignal }): Promise<GitArcEditApplyAttempt> {
    return await GitObjectReadSession.run(async () => {
      const { identity, repository, store } = await this.open(input.owner);
      const session = await this.requireSession(store, input.owner);
      if (session.metadata.phase !== "preview") throw new Error(`Edit session ${session.session} is already applied.`);
      if (!session.metadata.operations.length) throw new Error("The stored edit session has no readable operations. End it and start again.");
      const plan = await this.planner.plan(repository, session.metadata.operations, input.signal);
      if (!plan.files.length) throw new Error("The operations no longer change any files. End the session.");
      const blockers = await this.blockers(repository, identity, plan, input.checkPending);
      if (blockers.collisions.length) return { kind: "blocked" };
      if (blockers.dirty.length) {
        throw new Error(`Apply rejects unclaimed dirty paths; adopt them with git_arc_claims or exclude them from the operations: ${blockers.dirty.join(", ")}`);
      }
      if (blockers.pending.length) {
        throw new Error(`Apply rejects paths held by pending proposals; stack or rescind those proposals first: ${blockers.pending.join(", ")}`);
      }
      const comparedPaths = [...new Set([...plan.touchedPaths, ...session.metadata.touchedPaths])];
      const matchedPreview = plan.touchedPaths.length === session.metadata.touchedPaths.length
        && !(await repository.listChangedPaths(session.target, plan.target, comparedPaths)).length;
      let applied: GitArcEditSession | null = null;
      const write = async (publish: () => Promise<void>, additionalClaims: string[]) => {
        const prepared = await store.prepare(plan, this.metadata(plan, session.metadata.operations, {
          additionalClaims, matchedPreview, phase: "applied",
          ...(session.metadata.rootId ? { rootId: session.metadata.rootId } : {}),
        }));
        const rollback = await writeWorktreeFiles(repository, plan.expected, plan.writes);
        try {
          await publish();
          applied = await store.publish(input.owner, prepared, session.commit);
        } catch (error) {
          await rollback();
          throw error;
        }
      };
      if (plan.visiblePaths.length) await this.arc.claimAndWrite({ ...identity, claimPaths: plan.visiblePaths, write });
      else await write(async () => undefined, []);
      // Assigned inside `write`, which control-flow analysis cannot see through.
      const recorded = applied as GitArcEditSession | null;
      if (!recorded) throw new Error("The edit session was applied but its record was not written.");
      return { kind: "applied", result: this.result(recorded, "applied", 1) };
    });
  }

  async revert(input: { checkPending: GitArcEditPendingCheck; owner: GitArcEditOwner }) {
    return await GitObjectReadSession.run(async () => {
      const { identity, repository, store } = await this.open(input.owner);
      const session = await this.requireSession(store, input.owner);
      if (session.metadata.phase !== "applied") throw new Error(`Edit session ${session.session} is not applied. Run wb git arc edit end to discard it.`);
      const ignored = new Set(session.metadata.ignoredPaths);
      const touched = session.metadata.touchedPaths;
      const visible = touched.filter(filePath => !ignored.has(filePath));
      const held = visible.length ? await input.checkPending(visible.map(filePath => repository.resolvePath(filePath))) : [];
      if (held.length) {
        throw new Error(`Revert rejects paths held by pending proposals; stack or rescind those proposals first: ${held.map(absolute => path.relative(repository.root, absolute).replace(/\\/gu, "/")).join(", ")}`);
      }
      const current = new Map<string, GitTreeFile | null>();
      for (const filePath of touched) {
        const file = await readWorktreeFile(repository.resolvePath(filePath));
        if (file === "other") throw new Error(`${filePath} is no longer a file, so the edit session cannot revert it.`);
        current.set(filePath, file);
      }
      const merged = await repository.mergeWorktreeTrees(session.target, await repository.writeTreeWithFiles(session.target, current), session.base);
      if (merged.unsupportedConflictTypes.length) {
        throw new Error(`Reverting would leave conflicts that cannot be represented as editable markers: ${merged.unsupportedConflictTypes.join(", ")}`);
      }
      await writeWorktreeFiles(repository, current, await repository.readTreeFiles(merged.tree, touched));
      const sessionClaims = session.metadata.additionalClaims;
      let releasedClaims: string[] = [];
      if (sessionClaims.length && await this.arc.activeClaimPaths(identity)) {
        const dirty = new Set(await repository.listWorktreeChangedPaths(await repository.headOrNull(), sessionClaims));
        releasedClaims = sessionClaims.filter(filePath => !dirty.has(filePath));
        if (releasedClaims.length) await this.arc.releaseClaims({ ...identity, paths: releasedClaims });
      }
      await store.delete(input.owner, session.commit);
      return this.result(session, "reverted", 1, { conflictedPaths: merged.conflictedPaths, releasedClaims });
    });
  }

  async end(input: { owner: GitArcEditOwner }) {
    return await GitObjectReadSession.run(async () => {
      const { store } = await this.open(input.owner);
      const session = await this.requireSession(store, input.owner);
      await store.delete(input.owner, session.commit);
      return this.result(session, "ended", 1);
    });
  }
}
