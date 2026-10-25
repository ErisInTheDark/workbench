/*
 * Exports:
 * - default WorkbenchBranchPositionController: own demanded checkout ref facts (branch positions, peer commit previews,
 *   HEAD history, local branches and stashes), refreshed by one checkout ref watcher, and a checkout's upstream network
 *   I/O: pushes, on-demand fetches and observation-driven background fetches, one per repository at a time.
 * - WorkbenchBranchPositionFact: one observation's freshness, failure and position.
 */
import path from "node:path";
import type { GitBranchPosition, GitPeerAddress, GitPeerCommitsRequest } from "workbench-shared/workbench/git/git-peer-contracts";
import type { GitHistoryRequest } from "workbench-shared/workbench/git/git-history-contracts";
import type { WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";
import watchGitRefs from "../lib/workbench/git/git-ref-watch";
import WorkbenchGitPeerTransport from "../lib/workbench/git/WorkbenchGitPeerTransport";
import WorkbenchGitRefs from "../lib/workbench/git/WorkbenchGitRefs";
import WorkbenchGitRepository from "../lib/workbench/git/WorkbenchGitRepository";
import { isUpstreamFetchDue, UPSTREAM_FETCH_TICK_MS, type UpstreamFetchFocus } from "./upstream-fetch-schedule";

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

/** One repository's fetch freshness, shared by every worktree of it. */
interface FetchClock {
  /** When the last attempt finished, successful or not. */
  fetchedAt: number | null;
  failures: number;
  running: Promise<void> | null;
}

/** Which projects are observed, and how closely. */
type FetchDemand = () => ReadonlyMap<string, UpstreamFetchFocus>;

function message(error: unknown) {
  return (error instanceof Error ? error.message : "Branch position failed.").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
}

export default class WorkbenchBranchPositionController {
  private readonly checkouts = new Map<string, Checkout>();
  private readonly fetchDemand = new Set<FetchDemand>();
  /** Keyed by Git common directory, so linked worktrees share one clock and one fetch. */
  private readonly clocks = new Map<string, FetchClock>();
  private readonly commonDirs = new Map<string, Promise<string | null>>();
  private fetchTick: ReturnType<typeof setInterval> | null = null;
  /** Aborted on dispose, so a hung fetch can never hold a reload open. */
  private readonly lifetime = new AbortController();
  private closed = false;

  constructor(private readonly options: {
    /** The project's checkout root, or null when the project has none. */
    resolveRoot(projectId: string): Promise<string | null>;
    /** Checkouts another owner already fetches in the background. */
    backgroundFetchedElsewhere?: readonly string[];
    warn(message: string): void;
    watch?: typeof watchGitRefs;
  }) {}

  observe(projectId: string, peers: readonly GitPeerAddress[], listener: () => void) {
    const handle = this.observeValue(projectId, repository => new WorkbenchGitRefs(repository).position(peers), listener);
    return { read: (): WorkbenchBranchPositionFact => {
      const { data, ...fact } = handle.read();
      return { ...fact, position: data };
    }, release: handle.release };
  }

  observeCommits(projectId: string, request: GitPeerCommitsRequest, listener: () => void) {
    return this.observeValue(projectId, repository => new WorkbenchGitPeerTransport(repository).commits(request), listener);
  }

  observeHistory(projectId: string, request: GitHistoryRequest, listener: () => void) {
    return this.observeValue(projectId, repository => new WorkbenchGitRefs(repository).history(request), listener);
  }

  observeBranches(projectId: string, listener: () => void) {
    return this.observeValue(projectId, repository => new WorkbenchGitRefs(repository).branches(), listener);
  }

  observeStashes(projectId: string, listener: () => void) {
    return this.observeValue(projectId, repository => new WorkbenchGitRefs(repository).stashes(), listener);
  }

  /** Pushing moves the upstream tracking ref, so the ref watcher refreshes every observer afterwards. */
  async push(projectId: string, signal?: AbortSignal) {
    if (this.closed) throw new Error("Branch positions are reloading.");
    const repository = await this.open(projectId);
    if (!repository) throw new Error("This folder is not a Git checkout.");
    return await new WorkbenchGitRefs(repository).push(signal);
  }

  /** Fetch the checkout's upstream now, joining a fetch of the same repository already under way. */
  async fetch(projectId: string) {
    if (this.closed) throw new Error("Branch positions are reloading.");
    const root = await this.options.resolveRoot(projectId);
    const key = root ? await this.commonDir(root) : null;
    if (!root || !key) throw new Error("This folder is not a Git checkout.");
    await this.fetchRepository(root, key);
  }

  /**
   * Background-fetch demanded projects whenever their repository's last fetch outlives the focus's ttl. Demand is read
   * fresh on every check; `refresh` after it changes so a newly focused folder fetches at once.
   */
  trackFetchDemand(read: FetchDemand) {
    if (this.closed) throw new Error("Branch positions are reloading.");
    this.fetchDemand.add(read);
    this.fetchDue();
    return {
      refresh: () => { if (this.fetchDemand.has(read)) this.fetchDue(); },
      release: () => { if (this.fetchDemand.delete(read)) this.fetchDue(); },
    };
  }

  private demandedProjects() {
    const merged = new Map<string, UpstreamFetchFocus>();
    for (const read of this.fetchDemand) {
      for (const [projectId, focus] of read()) if (merged.get(projectId) !== "focused") merged.set(projectId, focus);
    }
    return merged;
  }

  /** The one tick only runs while something is demanded; it just notices ttls running out. */
  private fetchDue() {
    if (this.closed) return;
    const demand = this.demandedProjects();
    if (demand.size && !this.fetchTick) {
      this.fetchTick = setInterval(() => this.fetchDue(), UPSTREAM_FETCH_TICK_MS);
      this.fetchTick.unref();
    } else if (!demand.size && this.fetchTick) {
      clearInterval(this.fetchTick);
      this.fetchTick = null;
    }
    for (const [projectId, focus] of demand) void this.fetchIfDue(projectId, focus);
  }

  private async fetchIfDue(projectId: string, focus: UpstreamFetchFocus) {
    let target: { root: string; key: string } | null;
    try {
      const root = await this.options.resolveRoot(projectId);
      const key = root ? await this.commonDir(root) : null;
      target = root && key && !await this.fetchedElsewhere(key) ? { root, key } : null;
    }
    // An unresolvable project or checkout already fails its own observation; repeating that every tick adds nothing.
    catch { return; }
    if (!target || this.closed) return;
    const clock = this.clock(target.key);
    if (clock.running || !isUpstreamFetchDue({ ...clock, focus, now: Date.now() })) return;
    try { await this.fetchRepository(target.root, target.key); }
    catch (error) {
      // Warn once per failure streak; the ttl backs off until a fetch succeeds.
      if (clock.failures === 1 && !this.closed) this.options.warn(`Background upstream fetch failed: ${message(error)}`);
    }
  }

  private async fetchedElsewhere(key: string) {
    for (const root of this.options.backgroundFetchedElsewhere ?? []) if (await this.commonDir(root) === key) return true;
    return false;
  }

  private clock(key: string) {
    let clock = this.clocks.get(key);
    if (!clock) this.clocks.set(key, clock = { fetchedAt: null, failures: 0, running: null });
    return clock;
  }

  private async fetchRepository(root: string, key: string) {
    const clock = this.clock(key);
    clock.running ??= (async () => {
      try {
        const repository = await WorkbenchGitRepository.tryOpen(root);
        if (!repository) throw new Error("This folder is not a Git checkout.");
        await new WorkbenchGitRefs(repository).fetchUpstream(this.lifetime.signal);
        clock.failures = 0;
      } catch (error) {
        clock.failures++;
        throw error;
      } finally {
        clock.fetchedAt = Date.now();
        clock.running = null;
      }
    })();
    await clock.running;
  }

  /** A checkout's Git common directory; a root that is not a checkout resolves null until the daemon reloads. */
  private commonDir(root: string) {
    let resolved = this.commonDirs.get(root);
    if (!resolved) {
      resolved = (async () => {
        const repository = await WorkbenchGitRepository.tryOpen(root);
        if (!repository) return null;
        const directory = (await repository.run(["rev-parse", "--git-common-dir"])).trim();
        return path.resolve(repository.root, directory).replace(/\\/gu, "/").toLowerCase();
      })();
      this.commonDirs.set(root, resolved);
      // A failed read retries next time instead of pinning the failure.
      resolved.catch(() => { if (this.commonDirs.get(root) === resolved) this.commonDirs.delete(root); });
    }
    return resolved;
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
    this.lifetime.abort(new Error("Branch positions are reloading."));
    if (this.fetchTick) clearInterval(this.fetchTick);
    this.fetchTick = null;
    this.fetchDemand.clear();
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
