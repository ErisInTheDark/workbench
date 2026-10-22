/*
 * Exports:
 * - default WorkbenchGitCheckoutController: own a folder's commit and stash reads and its user ref moves (stash restore
 *   and drop, branch switch and creation, linked worktree creation, undoing HEAD) under the worktree Git transition,
 *   reporting threads a move would disturb instead of stranding their claims or proposals.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  GitCheckoutOwner, GitObjectDetail, GitObjectRef, GitRefMutation, GitRefMutationResult,
} from "workbench-shared/workbench/git/git-object-contracts";
import type { WorkingTreeDiff, WorkingTreePreview } from "workbench-shared/workbench/git/working-tree-contracts";
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import GitArcRegistry, { getGitArcLiveClaimPaths, type GitArcRegistryEntry } from "../lib/workbench/git/GitArcRegistry";
import type { GitArcThreadIdentityResolver } from "../lib/workbench/git/git-arc-thread-identity";
import WorkbenchGitRefs from "../lib/workbench/git/WorkbenchGitRefs";
import WorkbenchGitRepository from "../lib/workbench/git/WorkbenchGitRepository";
import WorkbenchWorkingTreeRepository from "../lib/workbench/git/WorkbenchWorkingTreeRepository";
import type { createWorktreeGitTransitions } from "./worktree-git-transitions";

const WORKTREE_FOLDER = [".workbench", "worktrees"] as const;

interface Options {
  /** The project's checkout root, or null when the project has none. */
  resolveRoot(projectId: string): Promise<string | null>;
  resolveIdentity: GitArcThreadIdentityResolver;
  readOwner(threadId: string, harness: string): Promise<GitCheckoutOwner | null>;
  transitions: Pick<ReturnType<typeof createWorktreeGitTransitions>, "read" | "run">;
  /** Catalogue a just-created worktree folder, returning its project. */
  discoverProject(rootPath: string): Promise<string | null>;
  /** Threads whose accepted proposals became this commit. */
  commitThreads?(projectId: string, sha: string): Promise<GitCheckoutOwner[]>;
  listClaims?(git: WorkbenchGitRepository): Promise<GitArcRegistryEntry[]>;
}

/** Git's own message for an expected refusal (dirty files in the way, an occupied branch), without paths or URLs. */
function refusal(error: unknown, fallback: string) {
  const fields = error && typeof error === "object" ? error as { stderr?: unknown; message?: unknown } : {};
  const text = [fields.stderr, fields.message].filter(value => typeof value === "string").join("\n");
  if (/would be overwritten/u.test(text)) return "Changes here would be overwritten. Commit or stash them first.";
  if (/already (checked out|used by worktree)/u.test(text)) return "That branch is already open in another worktree.";
  if (/already exists/u.test(text)) return "That name is already taken.";
  return fallback;
}

export default class WorkbenchGitCheckoutController {
  constructor(private readonly options: Options) {}

  private async open(projectId: string) {
    const root = await this.options.resolveRoot(projectId);
    const repository = root ? await WorkbenchGitRepository.tryOpen(root) : null;
    if (!repository) throw new Error("This folder is not a Git checkout.");
    return repository;
  }

  private async claims(git: WorkbenchGitRepository) {
    return this.options.listClaims ? await this.options.listClaims(git)
      : await new GitArcRegistry(git, this.options.resolveIdentity).list();
  }

  /** Threads holding live claims, pending proposals or a stack here; `paths` narrows to claims on those files. */
  private async owners(git: WorkbenchGitRepository, paths: readonly string[] | null) {
    const owners: GitCheckoutOwner[] = [];
    for (const claim of await this.claims(git)) {
      const live = getGitArcLiveClaimPaths(claim);
      const affected = paths
        ? paths.some(file => new GitArcPathSet(live).overlaps(file))
        : live.length > 0 || Boolean(claim.proposalIds?.length) || Boolean(claim.stackTip);
      if (!affected || owners.some(owner => owner.id === claim.threadId)) continue;
      const owner = await this.options.readOwner(claim.threadId, claim.harness);
      if (owner) owners.push(owner);
    }
    return owners;
  }

  async detail(projectId: string, object: GitObjectRef): Promise<GitObjectDetail> {
    const git = await this.open(projectId);
    const detail = await this.options.transitions.read(git.root, async () => await new WorkbenchGitRefs(git).objectDetail(object));
    const threads = object.kind === "commit" && this.options.commitThreads
      ? await this.options.commitThreads(projectId, object.sha).catch(() => []) : [];
    return { ...detail, threads };
  }

  private async file(projectId: string, object: GitObjectRef, filePath: string) {
    const git = await this.open(projectId);
    return await this.options.transitions.read(git.root, async () => {
      const entry = (await new WorkbenchGitRefs(git).objectFiles(object)).find(candidate => candidate.file.path === filePath);
      if (!entry) throw new Error("This file is not part of that change.");
      return { repository: new WorkbenchWorkingTreeRepository(git), ...entry };
    });
  }

  async diff(projectId: string, object: GitObjectRef, filePath: string): Promise<WorkingTreeDiff> {
    const { repository, file, sides } = await this.file(projectId, object, filePath);
    return await repository.diff(sides, file);
  }

  async preview(projectId: string, object: GitObjectRef, filePath: string): Promise<WorkingTreePreview> {
    const { repository, file } = await this.file(projectId, object, filePath);
    return await repository.preview(file);
  }

  async mutate(request: GitRefMutation): Promise<GitRefMutationResult> {
    const git = await this.open(request.projectId);
    try {
      return await this.options.transitions.run(git.root, async () => await this.apply(git, request));
    } finally {
      WorkbenchGitRepository.forgetRefFacts(git.root);
    }
  }

  private async apply(git: WorkbenchGitRepository, request: GitRefMutation): Promise<GitRefMutationResult> {
    const refs = new WorkbenchGitRefs(git);
    const complete = (extra: Partial<Extract<GitRefMutationResult, { status: "complete" }>> = {}): GitRefMutationResult => ({
      status: "complete", warnings: [], conflicts: [], worktree: null, ...extra,
    });
    switch (request.action) {
      case "dropStash": {
        const name = await refs.stashName(request.sha);
        if (name) await git.run(["stash", "drop", "--quiet", name]);
        return complete();
      }
      case "restoreStash": return await this.restoreStash(git, refs, request.sha);
      case "switchBranch": {
        if (await refs.branch() === request.branch) return complete();
        const owners = await this.owners(git, null);
        if (owners.length && !request.disturb) return { status: "disturbs", owners };
        try { await git.run(["switch", "--quiet", "--no-guess", request.branch]); }
        catch (error) { throw new Error(refusal(error, `Could not switch to ${request.branch}.`)); }
        return complete();
      }
      case "createBranch": {
        try { await git.run(["switch", "--quiet", "--create", request.branch]); }
        catch (error) { throw new Error(refusal(error, `Could not create ${request.branch}.`)); }
        return complete();
      }
      case "createWorktree": return await this.createWorktree(git, request.branch, request.create);
      case "undoCommit": {
        const detail = await refs.objectDetail({ kind: "commit", sha: request.sha });
        if (detail.undoBlocked) throw new Error(detail.undoBlocked);
        const owners = await this.owners(git, null);
        if (owners.length && !request.disturb) return { status: "disturbs", owners };
        await git.run(["reset", "--quiet", detail.parents[0] ?? request.sha]);
        return complete();
      }
    }
  }

  /**
   * Applies the stash onto the worktree, then drops it. Text conflicts stay as ordinary markers with no merge in
   * progress, and the stash is kept so nothing is lost; claimed files are never written.
   */
  private async restoreStash(git: WorkbenchGitRepository, refs: WorkbenchGitRefs, sha: string): Promise<GitRefMutationResult> {
    const name = await refs.stashName(sha);
    if (!name) throw new Error("This stash is gone.");
    const paths = (await refs.objectFiles({ kind: "stash", sha })).flatMap(({ file }) => [file.path, ...file.oldPath ? [file.oldPath] : []]);
    const owners = await this.owners(git, paths);
    if (owners.length) {
      throw new Error(`${owners.map(owner => owner.entry.title || "A thread").join(", ")} ${owners.length === 1 ? "claims" : "claim"} files this stash changes.`);
    }
    try {
      await git.run(["stash", "apply", "--quiet", name]);
    } catch (error) {
      const conflicts = (await git.run(["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
      if (!conflicts.length) throw new Error(refusal(error, "Could not restore this stash."));
      await git.run(["reset", "--quiet", "--", ...conflicts.map(file => git.literalPathspec(file))]);
      return { status: "complete", warnings: [], conflicts, worktree: null };
    }
    const after = await refs.stashName(sha);
    if (after) await git.run(["stash", "drop", "--quiet", after]);
    return { status: "complete", warnings: [], conflicts: [], worktree: null };
  }

  /** New worktrees live under the checkout's `.workbench/worktrees`, excluded locally so they never show as changes. */
  private async createWorktree(git: WorkbenchGitRepository, branch: string, create: boolean): Promise<GitRefMutationResult> {
    const name = branch.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "worktree";
    let target = path.join(git.root, ...WORKTREE_FOLDER, name);
    for (let suffix = 2; await fs.stat(target).then(() => true, () => false); suffix++) {
      target = path.join(git.root, ...WORKTREE_FOLDER, `${name}-${suffix}`);
    }
    const relative = `${WORKTREE_FOLDER.join("/")}/${path.basename(target)}`;
    if (!await git.succeeds(["check-ignore", "-q", "--no-index", relative])) {
      const exclude = path.resolve(git.root, (await git.run(["rev-parse", "--git-path", "info/exclude"])).trim());
      await fs.mkdir(path.dirname(exclude), { recursive: true });
      const existing = await fs.readFile(exclude, "utf8").catch(() => "");
      await fs.writeFile(exclude, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}/${WORKTREE_FOLDER.join("/")}/\n`);
    }
    try {
      await git.run(["worktree", "add", "--quiet", ...create ? ["-b", branch, target] : [target, branch]]);
    } catch (error) {
      throw new Error(refusal(error, `Could not open ${branch} in a new worktree.`));
    }
    const projectId = await this.options.discoverProject(target).catch(() => null);
    return { status: "complete", warnings: projectId ? [] : ["The new worktree is not in the folder list yet."], conflicts: [], worktree: { path: target, projectId } };
  }
}
