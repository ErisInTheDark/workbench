/*
 * Exports:
 * - WorkbenchClaimRenameRoot: catalogue-owned workspace root.
 * - WorkbenchClaimRenameRead: aliases and root-scoped history failures.
 * - default WorkbenchClaimRenameController: own serialized HEAD-keyed rename reads and disposal.
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

  read(projectId: string | null): Promise<WorkbenchClaimRenameRead> {
    const pending = this.queue.then(() => this.readCurrent(projectId));
    // The returned request retains its rejection; the queue only orders subsequent requests.
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async dispose() {
    this.lifetime.abort();
    await this.queue;
    this.cache.clear();
  }

  private async readCurrent(projectId: string | null): Promise<WorkbenchClaimRenameRead> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    const roots = await this.options.listRoots(projectId);
    signal.throwIfAborted();
    const result: WorkbenchClaimRenameRead = { renames: [], failures: [] };
    for (const root of roots) {
      try {
        const repository = await (this.options.openRepository ?? WorkbenchGitRepository.tryOpen)(root.workspaceRoot);
        signal.throwIfAborted();
        if (!repository) continue;
        const head = await repository.headOrNull();
        signal.throwIfAborted();
        let cached = this.cache.get(repository.root);
        if (!cached || cached.head !== head) {
          const renames = head ? await this.reader.read(repository, head, signal) : [];
          signal.throwIfAborted();
          cached = { head, renames };
          this.cache.set(repository.root, cached);
        }
        const projectRoots = roots.filter((candidate) => candidate.projectId === root.projectId);
        const owner = (file: string) => {
          const absolute = path.resolve(repository.root, file);
          return projectRoots
            .filter((candidate) => relativeWithin(candidate.workspaceRoot, absolute) !== null)
            .sort((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
        };
        // Reject the entire chain when any historical name belongs to another workspace root.
        const crossing = new Set(cached.renames.filter(({ from, to }) => owner(from)?.rootId !== owner(to)?.rootId).map(({ to }) => to));
        for (const rename of cached.renames) {
          if (crossing.has(rename.to) || owner(rename.from)?.rootId !== root.rootId || owner(rename.to)?.rootId !== root.rootId) continue;
          const from = relativeWithin(root.workspaceRoot, path.resolve(repository.root, rename.from));
          const to = relativeWithin(root.workspaceRoot, path.resolve(repository.root, rename.to));
          if (from && to) result.renames.push({ projectId: root.projectId, rootId: root.rootId, from, to });
        }
      } catch (error) {
        signal.throwIfAborted();
        const name = error instanceof Error ? error.name.replace(/[^a-zA-Z]/gu, "").slice(0, 40) : "Error";
        result.failures.push({ projectId: root.projectId, rootId: root.rootId, message: `Committed rename history is unavailable (${name}).` });
      }
    }
    return result;
  }
}

function relativeWithin(root: string, absolute: string) {
  const relative = path.relative(root, absolute).replace(/\\/gu, "/");
  return relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) ? null : relative;
}
