/*
 * Exports:
 * - WorkbenchClaimRenameRoot: catalogue-owned workspace root.
 * - WorkbenchClaimRenameScope: one claimed root and the earliest claim that a later rename could alias.
 * - WorkbenchClaimRenameRead: aliases and root-scoped history failures.
 * - default WorkbenchClaimRenameController: own serialized, HEAD-keyed rename reads for claimed roots only, and disposal.
 */
import path from "node:path";
import GitClaimRenameReader, { type GitClaimPathRename } from "../lib/workbench/git/GitClaimRenameReader";
import WorkbenchGitRepository from "../lib/workbench/git/WorkbenchGitRepository";
import type { WorkbenchGitClaimRename } from "./git-claim-observation";

export interface WorkbenchClaimRenameRoot {
  projectId: string;
  rootId: string;
  workspaceRoot: string;
}

export interface WorkbenchClaimRenameScope {
  projectId: string;
  rootId: string;
  /** Renames before the first claim cannot alias any claim, so history is walked from here. */
  since: number;
}

export interface WorkbenchClaimRenameRead {
  renames: WorkbenchGitClaimRename[];
  failures: Array<{ projectId: string; rootId: string; message: string }>;
}

export default class WorkbenchClaimRenameController {
  private readonly lifetime = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, { head: string | null; renames: GitClaimPathRename[] }>();
  private readonly reader: Pick<GitClaimRenameReader, "read">;

  constructor(private readonly options: {
    listRoots(projectId: string | null): Promise<WorkbenchClaimRenameRoot[]>;
    openRepository?(cwd: string): Promise<WorkbenchGitRepository | null>;
    reader?: Pick<GitClaimRenameReader, "read">;
  }) {
    this.reader = options.reader ?? new GitClaimRenameReader();
  }

  read(scopes: readonly WorkbenchClaimRenameScope[]): Promise<WorkbenchClaimRenameRead> {
    const pending = this.queue.then(() => this.readCurrent(scopes));
    // The returned request retains its rejection; the queue only orders subsequent requests.
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async dispose() {
    this.lifetime.abort();
    await this.queue;
    this.cache.clear();
  }

  private async readCurrent(scopes: readonly WorkbenchClaimRenameScope[]): Promise<WorkbenchClaimRenameRead> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    const result: WorkbenchClaimRenameRead = { renames: [], failures: [] };
    for (const projectId of new Set(scopes.map((scope) => scope.projectId))) {
      const roots = await this.options.listRoots(projectId);
      signal.throwIfAborted();
      for (const scope of scopes.filter((candidate) => candidate.projectId === projectId)) {
        const root = roots.find((candidate) => candidate.rootId === scope.rootId);
        // A claimed root that left the catalogue has no current history to alias into.
        if (!root) continue;
        try {
          result.renames.push(...await this.readRoot(root, roots, scope.since, signal));
        } catch (error) {
          signal.throwIfAborted();
          const name = error instanceof Error ? error.name.replace(/[^a-zA-Z]/gu, "").slice(0, 40) : "Error";
          result.failures.push({ projectId: root.projectId, rootId: root.rootId, message: `Committed rename history is unavailable (${name}).` });
        }
      }
    }
    return result;
  }

  private async readRoot(root: WorkbenchClaimRenameRoot, projectRoots: readonly WorkbenchClaimRenameRoot[], since: number, signal: AbortSignal) {
    const repository = await (this.options.openRepository ?? WorkbenchGitRepository.tryOpen)(root.workspaceRoot);
    signal.throwIfAborted();
    if (!repository) return [];
    const head = await repository.headOrNull();
    signal.throwIfAborted();
    const key = `${repository.root}\0${since}`;
    let cached = this.cache.get(key);
    if (!cached || cached.head !== head) {
      const renames = head ? await this.reader.read(repository, head, signal, since) : [];
      signal.throwIfAborted();
      cached = { head, renames };
      this.cache.set(key, cached);
    }
    const owner = (file: string) => {
      const absolute = path.resolve(repository.root, file);
      return projectRoots
        .filter((candidate) => relativeWithin(candidate.workspaceRoot, absolute) !== null)
        .sort((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
    };
    // Reject the entire chain when any historical name belongs to another workspace root.
    const crossing = new Set(cached.renames.filter(({ from, to }) => owner(from)?.rootId !== owner(to)?.rootId).map(({ to }) => to));
    const renames: WorkbenchGitClaimRename[] = [];
    for (const rename of cached.renames) {
      if (crossing.has(rename.to) || owner(rename.from)?.rootId !== root.rootId || owner(rename.to)?.rootId !== root.rootId) continue;
      const from = relativeWithin(root.workspaceRoot, path.resolve(repository.root, rename.from));
      const to = relativeWithin(root.workspaceRoot, path.resolve(repository.root, rename.to));
      if (from && to) renames.push({ projectId: root.projectId, rootId: root.rootId, from, to });
    }
    return renames;
  }
}

function relativeWithin(root: string, absolute: string) {
  const relative = path.relative(root, absolute).replace(/\\/gu, "/");
  return relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) ? null : relative;
}
