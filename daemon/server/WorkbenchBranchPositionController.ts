/*
 * Exports:
 * - default WorkbenchBranchPositionController: own demanded branch positions and peer commit previews, refreshed by one checkout ref watcher.
 * - WorkbenchBranchPositionFact: one observation's freshness, failure and position.
 */
import path from "node:path";
import type { GitBranchPosition, GitPeerAddress, GitPeerCommitsRequest } from "workbench-shared/workbench/git/git-peer-contracts";
import type { WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";
import watchGitRefs from "./lib/workbench/git/git-ref-watch";
import WorkbenchGitPeerTransport from "./lib/workbench/git/WorkbenchGitPeerTransport";
import WorkbenchGitRepository from "./lib/workbench/git/WorkbenchGitRepository";

export interface WorkbenchBranchPositionFact {
  phase: WorkspaceSourcePhase;
  failure: string | null;
  position: GitBranchPosition | null;
}

interface Reader {
  read(): Promise<void>;
  running: boolean;
  dirty: boolean;
}

interface Checkout {
  readers: Set<Reader>;
  repository: Promise<WorkbenchGitRepository | null>;
  stopWatch: (() => void) | null;
}

function message(error: unknown) {
  return (error instanceof Error ? error.message : "Branch position failed.").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
}

export default class WorkbenchBranchPositionController {
  private readonly checkouts = new Map<string, Checkout>();
  private closed = false;

  constructor(private readonly options: {
    /** The project's checkout root, or null when the project has none. */
    resolveRoot(projectId: string): Promise<string | null>;
    warn(message: string): void;
    watch?: typeof watchGitRefs;
  }) {}

  observe(projectId: string, peers: readonly GitPeerAddress[], listener: () => void) {
    const handle = this.observeValue(projectId, repository => new WorkbenchGitPeerTransport(repository).position(peers), listener);
    return { read: (): WorkbenchBranchPositionFact => {
      const { data, ...fact } = handle.read();
      return { ...fact, position: data };
    }, release: handle.release };
  }

  observeCommits(projectId: string, request: GitPeerCommitsRequest, listener: () => void) {
    return this.observeValue(projectId, repository => new WorkbenchGitPeerTransport(repository).commits(request), listener);
  }

  private observeValue<Value>(projectId: string, load: (repository: WorkbenchGitRepository) => Promise<Value>, listener: () => void) {
    if (this.closed) throw new Error("Branch positions are reloading.");
    let checkout = this.checkouts.get(projectId);
    if (!checkout) {
      const created: Checkout = { readers: new Set(), stopWatch: null, repository: this.open(projectId) };
      checkout = created;
      this.checkouts.set(projectId, created);
      void created.repository.then(async repository => {
        if (!repository || this.checkouts.get(projectId) !== created) return;
        const [gitDir, commonDir] = (await repository.run(["rev-parse", "--git-dir", "--git-common-dir"]))
          .trim().split(/\r?\n/u).map(directory => path.resolve(repository.root, directory));
        const stop = await (this.options.watch ?? watchGitRefs)({ gitDir: gitDir!, commonDir: commonDir! }, ["heads", "remotes"],
          () => { for (const reader of created.readers) this.read(created, reader); },
          error => this.options.warn(`Branch position watcher failed: ${message(error)}`));
        if (this.checkouts.get(projectId) === created) created.stopWatch = stop;
        else stop();
      }).catch(error => this.options.warn(`Branch position watcher unavailable: ${message(error)}`));
    }
    const owner = checkout;
    type Fact = { phase: WorkspaceSourcePhase; failure: string | null; data: Value | null };
    let fact: Fact = { phase: "pending", failure: null, data: null };
    const reader: Reader = { running: false, dirty: false, read: async () => {
      let next: Fact;
      try {
        const repository = await owner.repository;
        if (!owner.readers.has(reader)) return;
        next = repository
          ? { phase: "current", failure: null, data: await load(repository) }
          : { phase: "unavailable", failure: "This folder is not a Git checkout.", data: null };
      } catch (error) {
        const failure = message(error);
        this.options.warn(`Branch history failed: ${failure}`);
        next = { phase: fact.data ? "stale" : "failed", failure, data: fact.data };
      }
      if (!owner.readers.has(reader)) return;
      fact = next;
      try { listener(); }
      catch (error) { this.options.warn(`Branch history observer failed: ${message(error)}`); }
    } };
    checkout.readers.add(reader);
    this.read(owner, reader);
    return {
      read: () => fact,
      release: () => {
        if (!owner.readers.delete(reader) || owner.readers.size) return;
        owner.stopWatch?.();
        if (this.checkouts.get(projectId) === owner) this.checkouts.delete(projectId);
      },
    };
  }

  dispose() {
    this.closed = true;
    for (const checkout of this.checkouts.values()) {
      checkout.stopWatch?.();
      checkout.readers.clear();
    }
    this.checkouts.clear();
  }

  private async open(projectId: string) {
    const root = await this.options.resolveRoot(projectId);
    return root ? await WorkbenchGitRepository.tryOpen(root) : null;
  }

  /** Ref moves during a read coalesce into one subsequent read. */
  private read(checkout: Checkout, reader: Reader) {
    if (reader.running) { reader.dirty = true; return; }
    reader.running = true;
    void (async () => {
      try { do {
        reader.dirty = false;
        await reader.read();
      } while (reader.dirty && checkout.readers.has(reader)); }
      finally { reader.running = false; }
    })();
  }
}
