/*
 * Exports:
 * - default WorkbenchWorkingTreeController: own project-bound reads, live claim admission and drained mutations.
 */
import type {
  WorkingTreeFileRequest, WorkingTreeMutation, WorkingTreeRead, WorkingTreeRepository,
} from "workbench-shared/workbench/git/working-tree-contracts";
import { gitArcPathsOverlap } from "workbench-shared/workbench/git/git-arc-paths";
import GitArcRegistry, { getGitArcLiveClaimPaths, type GitArcRegistryEntry } from "./lib/workbench/git/GitArcRegistry";
import type { GitArcThreadIdentityResolver } from "./lib/workbench/git/git-arc-thread-identity";
import WorkbenchWorkingTreeRepository from "./lib/workbench/git/WorkbenchWorkingTreeRepository";
import WorkbenchGitRepository from "./lib/workbench/git/WorkbenchGitRepository";
import type { createWorktreeGitTransitions } from "./worktree-git-transitions";

type RepositoryPort = Pick<WorkbenchWorkingTreeRepository, "git" | "read" | "diff" | "preview" | "mutate">;
interface Options {
  resolveProject(projectId: string): Promise<{ roots: Array<{ id: string; name: string; rootPath: string }> }>;
  resolveIdentity: GitArcThreadIdentityResolver;
  readOwner(threadId: string, harness: string): Promise<WorkingTreeRepository["owners"][number] | null>;
  transitions: Pick<ReturnType<typeof createWorktreeGitTransitions>, "read" | "run">;
  openRepository?(cwd: string): Promise<RepositoryPort | null>;
  listClaims?(git: WorkbenchGitRepository): Promise<GitArcRegistryEntry[]>;
  warn?(message: string): void;
}

export default class WorkbenchWorkingTreeController {
  private disposed = false;
  private readonly reads = new Map<string, Promise<WorkingTreeRead>>();
  private readonly operations = new Set<Promise<object>>();
  constructor(private readonly options: Options) {}

  async dispose() {
    this.disposed = true;
    await Promise.allSettled([...this.operations]);
    this.reads.clear();
  }

  private async run<T extends object>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("Working tree is reloading.");
    const pending = operation();
    this.operations.add(pending);
    try { return await pending; }
    catch (error) {
      // Git stderr may contain source lines. Do not include it in diagnostics.
      (this.options.warn ?? console.warn)("Working-tree operation failed; failure returned to its caller.");
      throw error;
    } finally { this.operations.delete(pending); }
  }

  private async roots(projectId: string) {
    const project = await this.options.resolveProject(projectId);
    const roots: Array<{ id: string; name: string; repository: RepositoryPort }> = [];
    const errors: WorkingTreeRead["errors"] = [];
    for (const root of project.roots) {
      try {
        const repository = this.options.openRepository ? await this.options.openRepository(root.rootPath)
          : await WorkbenchGitRepository.tryOpen(root.rootPath).then(git => git ? new WorkbenchWorkingTreeRepository(git) : null);
        if (repository && !roots.some(root => root.repository.git.root === repository.git.root)) roots.push({ id: root.id, name: root.name, repository });
      } catch {
        (this.options.warn ?? console.warn)("Working-tree repository discovery failed for one selected-project root.");
        errors.push({ rootId: root.id, message: "Unable to open this repository. Check Git access." });
      }
    }
    return { roots, errors };
  }

  private async claims(git: WorkbenchGitRepository) {
    return this.options.listClaims ? await this.options.listClaims(git)
      : await new GitArcRegistry(git, this.options.resolveIdentity).list();
  }

  private async attachClaims(snapshot: WorkingTreeRepository, git: WorkbenchGitRepository) {
    const claims = await this.claims(git);
    const ownerIds = new Set<string>();
    snapshot.files = snapshot.files.map(file => ({
      ...file,
      ownerIds: claims.filter(claim => getGitArcLiveClaimPaths(claim).some(scope =>
        gitArcPathsOverlap(scope, file.path) || Boolean(file.oldPath && gitArcPathsOverlap(scope, file.oldPath)),
      )).map(claim => { ownerIds.add(claim.threadId); return claim.threadId; }),
    }));
    snapshot.owners = [];
    for (const id of ownerIds) {
      const claim = claims.find(claim => claim.threadId === id)!;
      const owner = await this.options.readOwner(id, claim.harness);
      if (owner) snapshot.owners.push(owner);
    }
    return snapshot;
  }

  async read(projectId: string): Promise<WorkingTreeRead> {
    if (this.disposed) throw new Error("Working tree is reloading.");
    const existing = this.reads.get(projectId);
    if (existing) return await existing;
    const pending = this.run(async () => {
      const { roots, errors } = await this.roots(projectId);
      const result: WorkingTreeRead = { repositories: [], errors };
      for (const root of roots) {
        try {
          const snapshot = await this.options.transitions.read(root.repository.git.root, async () => (
            await this.attachClaims(await root.repository.read(), root.repository.git)
          ));
          result.repositories.push({ ...snapshot, rootId: root.id, label: root.name });
        } catch {
          (this.options.warn ?? console.warn)("Working-tree scan failed for one selected-project root.");
          result.errors.push({ rootId: root.id, message: "Unable to inspect this repository. Retry after checking Git access." });
        }
      }
      return result;
    });
    this.reads.set(projectId, pending);
    try { return await pending; }
    finally { if (this.reads.get(projectId) === pending) this.reads.delete(projectId); }
  }

  private async root(projectId: string, rootId: string) {
    const { roots, errors } = await this.roots(projectId);
    const failure = errors.find(error => error.rootId === rootId);
    if (failure) throw new Error(failure.message);
    const root = roots.find(root => root.id === rootId);
    if (!root) throw new Error("Git root is not part of the selected project.");
    return root.repository;
  }

  private async file(request: WorkingTreeFileRequest, preview: boolean) {
    return await this.run(async () => {
      const repository = await this.root(request.projectId, request.rootId);
      return await this.options.transitions.read(repository.git.root, async () => {
        const snapshot = await repository.read();
        const file = snapshot.files.find(file => file.path === request.path && file.identity === request.identity);
        if (!file) throw new Error("File changed. Refresh its diff.");
        return preview ? await repository.preview(file) : await repository.diff(snapshot, file);
      });
    });
  }

  async diff(request: WorkingTreeFileRequest) {
    const result = await this.file(request, false);
    if (!("patch" in result)) throw new Error("Invalid diff result.");
    return result;
  }

  async preview(request: WorkingTreeFileRequest) {
    const result = await this.file(request, true);
    if (!("encoding" in result)) throw new Error("Invalid preview result.");
    return result;
  }

  async mutate(request: WorkingTreeMutation) {
    return await this.run(async () => {
      const repository = await this.root(request.projectId, request.rootId);
      return await this.options.transitions.run(repository.git.root, async () => {
        const snapshot = await this.attachClaims(await repository.read(), repository.git);
        const verifyClaims = async () => {
          const claims = await this.claims(repository.git);
          for (const selection of request.selections) {
            const file = snapshot.files.find(file => file.path === selection.path);
            if (!file) throw new Error("Selected file no longer exists.");
            if (claims.some(claim => getGitArcLiveClaimPaths(claim).some(scope =>
              gitArcPathsOverlap(scope, file.path) || Boolean(file.oldPath && gitArcPathsOverlap(scope, file.oldPath)),
            ))) throw new Error("Claimed files are inspect-only. Open their owning thread.");
          }
        };
        await verifyClaims();
        const result = await repository.mutate(snapshot, request, verifyClaims);
        if (result.status === "incomplete") (this.options.warn ?? console.warn)("Working-tree mutation incomplete; durable stash or worktree state requires inspection.");
        return result;
      });
    });
  }
}
