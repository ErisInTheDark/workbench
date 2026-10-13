/*
 * Exports:
 * - default WorkbenchBranchPositionController: own observed checkouts' branch positions against peer tracking refs,
 *   recounted whenever the checkout's refs move.
 * - WorkbenchBranchPositionFact: one observation's freshness, failure and position.
 */
import path from "node:path";
import type { GitBranchPosition, GitPeerAddress } from "workbench-shared/workbench/git/git-peer-contracts";
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
  peers: readonly GitPeerAddress[];
  fact: WorkbenchBranchPositionFact;
  listener: () => void;
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
    const reader: Reader = { peers, listener, running: false, dirty: false,
      fact: { phase: "pending", failure: null, position: null } };
    checkout.readers.add(reader);
    const owner = checkout;
    this.read(owner, reader);
    return {
      read: () => reader.fact,
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

  /** One count at a time per reader; ref moves during a count rerun it once it lands. */
  private read(checkout: Checkout, reader: Reader) {
    if (reader.running) { reader.dirty = true; return; }
    reader.running = true;
    void (async () => {
      try { do {
        reader.dirty = false;
        let next: WorkbenchBranchPositionFact;
        try {
          const repository = await checkout.repository;
          next = repository
            ? { phase: "current", failure: null, position: await new WorkbenchGitPeerTransport(repository).position(reader.peers) }
            : { phase: "unavailable", failure: "This folder is not a Git checkout.", position: null };
        } catch (error) {
          const failure = message(error);
          this.options.warn(`Branch position failed: ${failure}`);
          next = { phase: reader.fact.position ? "stale" : "failed", failure, position: reader.fact.position };
        }
        if (!checkout.readers.has(reader)) return;
        reader.fact = next;
        try { reader.listener(); }
        catch (error) { this.options.warn(`Branch position observer failed: ${message(error)}`); }
      } while (reader.dirty && checkout.readers.has(reader)); }
      finally { reader.running = false; }
    })();
  }
}
