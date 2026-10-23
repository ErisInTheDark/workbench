/*
 * Exports:
 * - ReloadDirtSourceDescriptor/ReloadDirtSourceState: current source ownership and dependant metadata.
 * - ReloadDirtControllerState: transferable snapshots, baselines, pending scopes and refresh lifecycle.
 * - ReloadDependencySource: dependency-backed dirt; `loaded` closures changed since process start, `install` lockfile drift.
 * - ReloadDirtControllerOptions: snapshot, watcher, dependency, schema manifest and dynamic-source ports.
 * - default ReloadDirtController: reconcile source content against per-scope Git baselines, mark schema migrations a
 *   reload would apply, and predict the dirt an incoming change set would cause.
 */
import { type watch } from "node:fs";

import { hasDependencyDrift, readDependencyFingerprint } from "../pnpm-dependency-state.mjs";
import type {
  WorkbenchReloadScope,
  WorkbenchReloadScopeDescriptor,
} from "./workbench-reload.ts";
import type { ReloadDirtScope, ReloadDirtSnapshot } from "./reload-dirt-scope.ts";
import { schemaMigrationBetween, type ReloadSchemaManifest } from "./reload-schema-manifest.ts";
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
  /** Installed closure fingerprints first seen by this process; absent in states transferred from older code. */
  dependencyBaselines?: Map<WorkbenchReloadScope, string | null>;
  descriptors: Map<WorkbenchReloadScope, ReloadDirtSourceDescriptor>;
  error: string | null;
  pendingScopes: WorkbenchReloadScope[];
  refreshAbort?: AbortController;
  snapshotCommit: string;
  tail: Promise<void>;
}

export type ReloadDependencySource =
  | { kind: "loaded"; scope: WorkbenchReloadScope; importers: readonly string[] }
  | { kind: "install"; scope: WorkbenchReloadScope };

const DEPENDENCY_LOCKFILES = ["pnpm-lock.yaml", "node_modules/.pnpm/lock.yaml"];

export interface ReloadDirtControllerOptions {
  connectSourceObserver?(observe: (scope: WorkbenchReloadScope, sourcePath: string) => void): () => void;
  dependencySources?: readonly ReloadDependencySource[];
  getSourceState(): ReloadDirtSourceState;
  isPotentialSourcePath?(sourcePath: string): boolean;
  onChange?(): void;
  repository?: ReloadDirtSnapshotRepositoryPort;
  repoRoot: string;
  /** Release manifests whose newer versions migrate a store when their owning scopes reload. */
  schemaManifests?: readonly ReloadSchemaManifest[];
  snapshotRef: string;
  watchSource?: typeof watch;
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

function sameSnapshot(left: ReloadDirtSnapshot, right: ReloadDirtSnapshot) {
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
        && candidate.migration?.from === scope.migration?.from
        && candidate.migration?.to === scope.migration?.to
        && dependantScopes.length === candidateDependantScopes.length
        && dependantScopes.every((dependantScope, dependantIndex) => dependantScope === candidateDependantScopes[dependantIndex]);
    });
}

/** Keeps the previous source list when nothing was added, so its identity marks the watcher's coverage current. */
function mergeDescriptorSources(
  previous: ReloadDirtSourceDescriptor | undefined,
  current: ReloadDirtSourceDescriptor,
) {
  const paths = [...new Set([...previous?.paths ?? [], ...current.paths])].sort();
  const unchanged = previous?.paths.length === paths.length && previous.paths.every((source, index) => source === paths[index]);
  return {
    ...current,
    boundaryPatterns: current.boundaryPatterns ?? previous?.boundaryPatterns,
    paths: unchanged ? previous.paths : paths,
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
  private snapshot: ReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };
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
    const diagnostic = (stage: string) => {
      if (process.env.WORKBENCH_STARTUP_DIAGNOSTICS === "1") console.info(`[startup] reload sources: ${stage}`);
    };
    if (!this.state) {
      const sourceState = this.options.getSourceState();
      diagnostic("capturing Git baseline");
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
    diagnostic("connecting filesystem watcher");
    await this.connectWatcher();
    if (!this.attached) return;
    if (state.pendingScopes.length) {
      this.publish({ dirtyScopes: [], error: state.error, pendingScopes: state.pendingScopes });
    } else {
      diagnostic("comparing initial source state");
      await this.refresh();
    }
    diagnostic("ready");
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
      // Dependency dirt is not source content; only its own check, below, may clear it.
      const dependencyScopes = new Set((this.options.dependencySources ?? []).map(({ scope }) => scope));
      this.publish({
        dirtyScopes: this.snapshot.dirtyScopes.filter(({ scope }) => !applied.has(scope) || dependencyScopes.has(scope)),
        error: null,
        pendingScopes: [],
      });
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
        { paths: this.options.dependencySources?.length ? DEPENDENCY_LOCKFILES : [] },
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
      let coverageChanged = false;
      for (const scope of state.descriptors.keys()) {
        if (currentScopes.has(scope)) continue;
        state.descriptors.delete(scope);
        state.baselines.delete(scope);
        coverageChanged = true;
      }
      for (const descriptor of sourceState.descriptors) {
        const previous = state.descriptors.get(descriptor.scope);
        const merged = mergeDescriptorSources(previous, descriptor);
        coverageChanged ||= merged.paths !== previous?.paths
          || (merged.boundaryPatterns ?? []).join("\n") !== (previous?.boundaryPatterns ?? []).join("\n");
        state.descriptors.set(descriptor.scope, merged);
      }
      // The watcher follows directory changes itself; it only needs reconciling when source coverage moved.
      if (coverageChanged) await this.watcher?.refresh();
      if (signal?.aborted) throw signal.reason;
      const dirtyScopes = [] as ReloadDirtSnapshot["dirtyScopes"];
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
      for (const scope of await this.dependencyDirt()) dirtyScopeNames.add(scope);
      if (signal?.aborted) throw signal.reason;
      for (const descriptor of descriptors) {
        if (!dirtyScopeNames.has(descriptor.scope)) continue;
        const baseline = state.baselines.get(descriptor.scope) ?? state.snapshotCommit;
        const owned = resolvedPaths.get(descriptor.scope) ?? [];
        const changed = changedByBaseline.get(baseline) ?? new Set<string>();
        dirtyScopes.push(await this.describeDirtyScope(sourceState, descriptor, baseline, null,
          manifest => owned.includes(manifest.path) && changed.has(manifest.path), signal));
      }
      if (signal?.aborted) throw signal.reason;
      state.error = null;
      this.publish({ dirtyScopes, error: null, pendingScopes: state.pendingScopes });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      this.publishError(error);
    }
  }

  private async dependencyDirt() {
    const state = this.requireState();
    const baselines = state.dependencyBaselines ??= new Map();
    const dirty: WorkbenchReloadScope[] = [];
    for (const source of this.options.dependencySources ?? []) {
      if (!state.descriptors.has(source.scope)) throw new Error(`Dependency reload source names unknown scope ${source.scope}.`);
      if (source.kind === "install") {
        if (await hasDependencyDrift(this.options.repoRoot)) dirty.push(source.scope);
        continue;
      }
      const current = await readDependencyFingerprint(this.options.repoRoot, "installed", source.importers);
      if (!baselines.has(source.scope)) baselines.set(source.scope, current);
      else if (baselines.get(source.scope) !== current) dirty.push(source.scope);
    }
    return dirty;
  }

  /**
   * The scopes an incoming change set would dirty, as if `target` were checked out now: a scope is predicted when one of
   * its sources or boundary patterns names an incoming path, or an incoming lockfile drives its install. Migrations compare
   * each owned manifest at the scope's loaded baseline with `target`.
   */
  async predict(incomingPaths: readonly string[], target: string, signal?: AbortSignal): Promise<ReloadDirtScope[]> {
    const state = this.requireState();
    const sourceState = this.options.getSourceState();
    const incoming = new Set(incomingPaths);
    const installScopes = new Set(incoming.has("pnpm-lock.yaml")
      ? (this.options.dependencySources ?? []).filter(({ kind }) => kind === "install").map(({ scope }) => scope)
      : []);
    const predicted: ReloadDirtScope[] = [];
    for (const descriptor of state.descriptors.values()) {
      const matcher = boundaryMatcher(descriptor);
      const owns = (sourcePath: string) => descriptor.paths.includes(sourcePath) || Boolean(matcher?.matches(sourcePath));
      if (!installScopes.has(descriptor.scope) && !incomingPaths.some(owns)) continue;
      const baseline = state.baselines.get(descriptor.scope) ?? state.snapshotCommit;
      predicted.push(await this.describeDirtyScope(sourceState, descriptor, baseline, target,
        manifest => incoming.has(manifest.path) && owns(manifest.path), signal));
      signal?.throwIfAborted();
    }
    return predicted;
  }

  private async describeDirtyScope(
    sourceState: ReloadDirtSourceState,
    descriptor: ReloadDirtSourceDescriptor,
    baseline: string,
    target: string | null,
    migrates: (manifest: ReloadSchemaManifest) => boolean,
    signal?: AbortSignal,
  ): Promise<ReloadDirtScope> {
    const scope: ReloadDirtScope = {
      dependantScopes: sourceState.dependantClosure([descriptor.scope]).filter((candidate) => candidate !== descriptor.scope),
      description: descriptor.description,
      destructive: descriptor.destructive === true,
      scope: descriptor.scope,
    };
    for (const manifest of this.options.schemaManifests ?? []) {
      if (!migrates(manifest)) continue;
      const migration = schemaMigrationBetween(manifest,
        await this.repository.readFile(baseline, manifest.path, signal),
        await this.repository.readFile(target, manifest.path, signal));
      if (migration) return { ...scope, migration };
    }
    return scope;
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

  private publish(snapshot: ReloadDirtSnapshot) {
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
