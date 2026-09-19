/*
 * Exports:
 * - ReloadDirtSourceDescriptor/ReloadDirtSourceState: current source ownership and dependant metadata.
 * - ReloadDirtControllerState: transferable snapshots, baselines, pending scopes and refresh lifecycle.
 * - ReloadDirtExternalSource/ReloadDirtControllerOptions: snapshot, watcher and dynamic-source ports.
 * - default ReloadDirtController: reconcile source content against per-scope Git baselines.
 */
import { type watch } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import type {
  WorkbenchReloadDirtSnapshot,
  WorkbenchReloadScope,
  WorkbenchReloadScopeDescriptor,
} from "./workbench-reload.ts";
import ReloadDirtSnapshotRepository, {
  type ReloadDirtSnapshotRepositoryPort,
} from "./ReloadDirtSnapshotRepository.ts";
import { createGitignoreMatcher } from "../source-pattern-matcher.ts";
import ReloadSourceWatcher from "./ReloadSourceWatcher.ts";

const MAX_ERROR_LENGTH = 500;

export interface ReloadDirtSourceDescriptor extends WorkbenchReloadScopeDescriptor {
  boundaryPatterns?: readonly string[];
  paths: readonly string[];
}

export interface ReloadDirtSourceState {
  dependantClosure(scopes: readonly WorkbenchReloadScope[]): WorkbenchReloadScope[];
  descriptors: readonly ReloadDirtSourceDescriptor[];
}

export interface ReloadDirtControllerState {
  baselines: Map<WorkbenchReloadScope, string>;
  descriptors: Map<WorkbenchReloadScope, ReloadDirtSourceDescriptor>;
  error: string | null;
  pendingScopes: WorkbenchReloadScope[];
  refreshAbort?: AbortController;
  snapshotCommit: string;
  tail: Promise<void>;
}

export interface ReloadDirtExternalSource {
  path: string;
  scope: WorkbenchReloadScope;
}

export interface ReloadDirtControllerOptions {
  connectSourceObserver?(observe: (scope: WorkbenchReloadScope, sourcePath: string) => void): () => void;
  externalDirtSources?: readonly ReloadDirtExternalSource[];
  getSourceState(): ReloadDirtSourceState;
  isPotentialSourcePath?(sourcePath: string): boolean;
  onChange?(): void;
  repository?: ReloadDirtSnapshotRepositoryPort;
  repoRoot: string;
  snapshotRef: string;
  watchSource?: typeof watch;
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

async function pathExists(filename: string) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sameSnapshot(left: WorkbenchReloadDirtSnapshot, right: WorkbenchReloadDirtSnapshot) {
  return left.error === right.error
    && left.pendingScopes.length === right.pendingScopes.length
    && left.pendingScopes.every((scope, index) => scope === right.pendingScopes[index])
    && left.dirtyScopes.length === right.dirtyScopes.length
    && left.dirtyScopes.every((scope, index) => {
      const candidate = right.dirtyScopes[index];
      const dependantScopes = scope.dependantScopes ?? [];
      const candidateDependantScopes = candidate?.dependantScopes ?? [];
      return candidate?.scope === scope.scope
        && candidate.description === scope.description
        && candidate.destructive === scope.destructive
        && dependantScopes.length === candidateDependantScopes.length
        && dependantScopes.every((dependantScope, dependantIndex) => dependantScope === candidateDependantScopes[dependantIndex]);
    });
}

function mergeDescriptorSources(
  previous: ReloadDirtSourceDescriptor | undefined,
  current: ReloadDirtSourceDescriptor,
) {
  return {
    ...current,
    boundaryPatterns: current.boundaryPatterns ?? previous?.boundaryPatterns,
    paths: [...new Set([...previous?.paths ?? [], ...current.paths])].sort(),
  };
}

function boundaryMatcher(descriptor: ReloadDirtSourceDescriptor) {
  const patterns = descriptor.boundaryPatterns ?? [];
  return patterns.length ? createGitignoreMatcher(patterns.join("\n")) : null;
}

export default class ReloadDirtController {
  private attached = true;
  private clearSourceObserver: (() => void) | null = null;
  private refreshAbort: AbortController;
  private readonly repository: ReloadDirtSnapshotRepositoryPort;
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkbenchReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };
  private tail: Promise<void>;
  private watcher: ReloadSourceWatcher | null = null;
  private watcherRefreshPending = false;
  private watcherRefreshRunning = false;

  constructor(
    private readonly options: ReloadDirtControllerOptions,
    private state: ReloadDirtControllerState | null = null,
  ) {
    this.repository = options.repository ?? new ReloadDirtSnapshotRepository(options.repoRoot);
    this.refreshAbort = state?.refreshAbort ?? new AbortController();
    this.tail = state?.tail ?? Promise.resolve();
  }

  async start() {
    if (!this.state) {
      const sourceState = this.options.getSourceState();
      const snapshotCommit = await this.writeSnapshot("load reload node graph");
      this.state = {
        baselines: new Map(sourceState.descriptors.map(({ scope }) => [scope, snapshotCommit])),
        descriptors: new Map(sourceState.descriptors.map((descriptor) => [descriptor.scope, descriptor])),
        error: null,
        pendingScopes: [],
        refreshAbort: this.refreshAbort,
        snapshotCommit,
        tail: this.tail,
      };
    }
    const state = this.requireState();
    state.refreshAbort = this.refreshAbort;
    this.connectSourceObserver();
    await this.connectWatcher();
    if (!this.attached) return;
    if (state.pendingScopes.length) {
      this.publish({ dirtyScopes: [], error: state.error, pendingScopes: state.pendingScopes });
    } else {
      await this.refresh();
    }
  }

  getSnapshot() {
    return this.snapshot;
  }

  getCatalog() {
    return [...this.requireState().descriptors.values()].map(({
      boundaryPatterns: _boundaryPatterns,
      paths: _paths,
      ...descriptor
    }) => descriptor);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginReload(scopes: readonly WorkbenchReloadScope[]) {
    const state = this.requireState();
    this.supersedeRefreshes();
    state.pendingScopes = [...new Set(scopes)];
    state.error = null;
    this.publish({ ...this.snapshot, error: null, pendingScopes: state.pendingScopes });
  }

  async completeReload(requestedScopes: readonly WorkbenchReloadScope[]) {
    await this.enqueue(async () => {
      const state = this.requireState();
      const sourceState = this.options.getSourceState();
      const applied = new Set(sourceState.dependantClosure(requestedScopes));
      const snapshotCommit = await this.writeSnapshot(`reload ${[...applied].join(", ")}`);
      const fresh = new Map(sourceState.descriptors.map((descriptor) => [descriptor.scope, descriptor]));
      for (const scope of applied) {
        const descriptor = fresh.get(scope);
        if (descriptor) state.descriptors.set(scope, descriptor);
        else state.descriptors.delete(scope);
        state.baselines.set(scope, snapshotCommit);
      }
      state.snapshotCommit = snapshotCommit;
      state.pendingScopes = [];
      state.error = null;
      this.connectSourceObserver();
      await this.refreshNow();
    });
  }

  failReload(error: unknown) {
    const state = this.requireState();
    state.pendingScopes = [];
    state.error = boundedError(error);
    this.connectSourceObserver();
    this.publish({ ...this.snapshot, error: state.error, pendingScopes: [] });
  }

  async refresh(signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    if (this.requireState().pendingScopes.length) return this.snapshot;
    const lifecycleSignal = this.refreshAbort.signal;
    const refreshSignal = signal ? AbortSignal.any([signal, lifecycleSignal]) : lifecycleSignal;
    await this.enqueue(async () => await this.refreshNow(refreshSignal));
    return this.snapshot;
  }

  detachForReload() {
    this.attached = false;
    this.disconnectRuntimeOwners();
    const state = this.requireState();
    state.refreshAbort = this.refreshAbort;
    state.tail = this.tail;
    return state;
  }

  resumeAfterFailedReload() {
    if (this.attached) return;
    this.attached = true;
    this.connectSourceObserver();
    void this.connectWatcher().catch(error => this.publishError(error));
  }

  async dispose() {
    this.attached = false;
    this.disconnectRuntimeOwners();
    await this.tail;
  }

  private addSourcePath(scope: WorkbenchReloadScope, sourcePath: string) {
    const state = this.requireState();
    const descriptor = state.descriptors.get(scope);
    if (!descriptor || descriptor.paths.includes(sourcePath)) return;
    state.descriptors.set(scope, {
      ...descriptor,
      paths: [...descriptor.paths, sourcePath].sort(),
    });
    void this.watcher?.refresh().catch(error => this.publishError(error));
    this.queueRefresh();
  }

  private connectSourceObserver() {
    this.clearSourceObserver?.();
    this.clearSourceObserver = this.options.connectSourceObserver?.((scope, sourcePath) => {
      this.addSourcePath(scope, sourcePath.replace(/\\/gu, "/"));
    }) ?? null;
  }

  private async connectWatcher() {
    this.watcher?.close();
    this.watcher = new ReloadSourceWatcher({
      root: this.options.repoRoot,
      getScopes: () => [
        ...[...this.requireState().descriptors.values()].map(descriptor => ({
          paths: descriptor.paths,
          patterns: descriptor.boundaryPatterns,
        })),
        { paths: (this.options.externalDirtSources ?? []).map(source => source.path) },
      ],
      onChange: () => this.queueRefresh(),
      onError: error => this.publishError(error),
      watchSource: this.options.watchSource,
      isPotentialSourcePath: this.options.isPotentialSourcePath,
    });
    await this.watcher.refresh();
  }

  private disconnectRuntimeOwners() {
    this.clearSourceObserver?.();
    this.clearSourceObserver = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private async enqueue(operation: () => Promise<void>) {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    if (this.state) this.state.tail = this.tail;
    await next;
  }

  private async refreshNow(signal?: AbortSignal) {
    const state = this.requireState();
    try {
      if (signal?.aborted) throw signal.reason;
      const sourceState = this.options.getSourceState();
      const currentScopes = new Set(sourceState.descriptors.map(({ scope }) => scope));
      for (const scope of state.descriptors.keys()) {
        if (currentScopes.has(scope)) continue;
        state.descriptors.delete(scope);
        state.baselines.delete(scope);
      }
      for (const descriptor of sourceState.descriptors) {
        state.descriptors.set(
          descriptor.scope,
          mergeDescriptorSources(state.descriptors.get(descriptor.scope), descriptor),
        );
      }
      await this.watcher?.refresh();
      if (signal?.aborted) throw signal.reason;
      const dirtyScopes = [] as WorkbenchReloadDirtSnapshot["dirtyScopes"];
      const descriptors = [...state.descriptors.values()];
      const hasBoundaryPatterns = descriptors.some(({ boundaryPatterns }) => boundaryPatterns?.length);
      const worktreePaths = hasBoundaryPatterns
        ? await this.repository.listWorktreePaths(signal)
        : [];
      const resolvedPaths = new Map(descriptors.map((descriptor) => {
        const matcher = boundaryMatcher(descriptor);
        return [
          descriptor.scope,
          [...new Set([
            ...descriptor.paths,
            ...(matcher ? worktreePaths.filter((sourcePath) => matcher.matches(sourcePath)) : []),
          ])].sort(),
        ] as const;
      }));
      const gitDescriptors = descriptors.filter(({ scope }) => resolvedPaths.get(scope)?.length);
      const pathsByBaseline = new Map<string, Set<string>>();
      for (const descriptor of gitDescriptors) {
        const baseline = state.baselines.get(descriptor.scope) ?? state.snapshotCommit;
        const paths = pathsByBaseline.get(baseline) ?? new Set<string>();
        for (const sourcePath of resolvedPaths.get(descriptor.scope) ?? []) paths.add(sourcePath);
        pathsByBaseline.set(baseline, paths);
      }
      const changedByBaseline = new Map<string, Set<string>>();
      for (const [baseline, paths] of pathsByBaseline) {
        const sourcePaths = [...paths];
        changedByBaseline.set(
          baseline,
          new Set(await this.repository.listWorktreeChangedPaths(baseline, sourcePaths, signal)),
        );
        if (signal?.aborted) throw signal.reason;
      }
      const dirtyScopeNames = new Set<WorkbenchReloadScope>();
      for (const descriptor of gitDescriptors) {
        const baseline = state.baselines.get(descriptor.scope) ?? state.snapshotCommit;
        const changed = changedByBaseline.get(baseline) ?? new Set<string>();
        if (resolvedPaths.get(descriptor.scope)?.some((sourcePath) => changed.has(sourcePath))) {
          dirtyScopeNames.add(descriptor.scope);
        }
      }
      for (const source of this.options.externalDirtSources ?? []) {
        if (!state.descriptors.has(source.scope)) {
          throw new Error(`External reload dirt source ${source.path} names unknown scope ${source.scope}.`);
        }
        if (await pathExists(path.join(this.options.repoRoot, source.path))) dirtyScopeNames.add(source.scope);
        if (signal?.aborted) throw signal.reason;
      }
      for (const descriptor of descriptors) {
        if (dirtyScopeNames.has(descriptor.scope)) {
          dirtyScopes.push({
            dependantScopes: sourceState.dependantClosure([descriptor.scope]).filter((scope) => scope !== descriptor.scope),
            description: descriptor.description,
            destructive: descriptor.destructive === true,
            scope: descriptor.scope,
          });
        }
      }
      if (signal?.aborted) throw signal.reason;
      state.error = null;
      this.publish({ dirtyScopes, error: null, pendingScopes: state.pendingScopes });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.publishError(error);
    }
  }

  private async writeSnapshot(message: string) {
    const tree = await this.repository.writeWorktreeTree();
    const previous = this.state?.snapshotCommit
      ?? await this.repository.readRef(this.options.snapshotRef)
      ?? await this.repository.readRef("HEAD");
    if (!previous) throw new Error("Reload dirt snapshots require a usable Git HEAD.");
    const commit = await this.repository.createCommitFromTree(tree, previous, `workbench reload snapshot\n\n${message}`);
    const currentRef = await this.repository.readRef(this.options.snapshotRef);
    await this.repository.updateRef(this.options.snapshotRef, commit, currentRef ?? undefined);
    return commit;
  }

  private queueRefresh() {
    if (!this.attached || this.requireState().pendingScopes.length) return;
    this.watcherRefreshPending = true;
    if (this.watcherRefreshRunning) return;
    this.watcherRefreshRunning = true;
    setImmediate(() => { void this.runWatcherRefreshes(); });
  }

  private async runWatcherRefreshes() {
    const expectedSignal = this.refreshAbort.signal;
    try {
      while (
        this.attached
        && !this.requireState().pendingScopes.length
        && this.watcherRefreshPending
      ) {
        this.watcherRefreshPending = false;
        await this.refresh();
      }
    } catch (error) {
      if (!(expectedSignal.aborted && error === expectedSignal.reason)) this.publishError(error);
    } finally {
      this.watcherRefreshRunning = false;
      if (!this.attached || this.requireState().pendingScopes.length) {
        this.watcherRefreshPending = false;
      } else if (this.watcherRefreshPending) {
        this.queueRefresh();
      }
    }
  }

  private supersedeRefreshes() {
    this.refreshAbort.abort(new Error("Reload dirt refresh was superseded by a user reload."));
    this.refreshAbort = new AbortController();
    this.tail = Promise.resolve();
    const state = this.requireState();
    state.refreshAbort = this.refreshAbort;
    state.tail = this.tail;
  }

  private publishError(error: unknown) {
    const state = this.requireState();
    state.error = boundedError(error);
    this.publish({ ...this.snapshot, error: state.error, pendingScopes: state.pendingScopes });
  }

  private publish(snapshot: WorkbenchReloadDirtSnapshot) {
    if (sameSnapshot(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
    if (!this.attached) return;
    this.options.onChange?.();
    for (const listener of this.listeners) listener();
  }

  private requireState() {
    if (!this.state) throw new Error("Reload dirt controller is not started.");
    return this.state;
  }
}
