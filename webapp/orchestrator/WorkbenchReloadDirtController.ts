/*
 * Exports:
 * - WorkbenchReloadDirtControllerState: transferable snapshot, baseline, and generated-path state. Keywords: reload, dirt, handoff.
 * - WorkbenchReloadDirtControllerOptions: workspace, graph, and publication ports. Keywords: reload, ports, Git.
 * - default WorkbenchReloadDirtController: own reload dirt, full-worktree snapshots, source generations, and watcher lifecycle. Keywords: reload, dirt, snapshot, watcher.
 */
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { OrchestratorReloadScope, WorkbenchReloadDirtSnapshot } from "../lib/types";
import WorkbenchGitRepository from "../lib/workbench/git/WorkbenchGitRepository";
import { setActiveReloadInstructionObserver } from "../lib/workbench/reload-source-observer";
import type { ReloadNodeSourceDescriptor, ReloadNodeSourceState } from "./reload-node-source-map";

const RELOAD_SNAPSHOT_REF = "refs/worktree/workbench/reload-snapshot";
const MAX_ERROR_LENGTH = 500;

export interface WorkbenchReloadDirtControllerState {
  baselines: Map<OrchestratorReloadScope, string>;
  descriptors: Map<OrchestratorReloadScope, ReloadNodeSourceDescriptor>;
  error: string | null;
  pendingScopes: OrchestratorReloadScope[];
  snapshotCommit: string;
}

export interface WorkbenchReloadDirtControllerOptions {
  activateSourceState?(): ReloadNodeSourceState;
  cancelSourceState?(): void;
  getSourceState(): ReloadNodeSourceState;
  onChange?(): void;
  repoRoot: string;
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

function sameSnapshot(left: WorkbenchReloadDirtSnapshot, right: WorkbenchReloadDirtSnapshot) {
  return left.error === right.error
    && left.pendingScopes.length === right.pendingScopes.length
    && left.pendingScopes.every((scope, index) => scope === right.pendingScopes[index])
    && left.dirtyScopes.length === right.dirtyScopes.length
    && left.dirtyScopes.every((scope, index) => {
      const candidate = right.dirtyScopes[index];
      return candidate?.scope === scope.scope
        && candidate.description === scope.description
        && candidate.destructive === scope.destructive;
    });
}

export default class WorkbenchReloadDirtController {
  private attached = true;
  private clearInstructionObserver: (() => void) | null = null;
  private refreshQueued = false;
  private repository: WorkbenchGitRepository;
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkbenchReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };
  private tail = Promise.resolve();
  private watcher: FSWatcher | null = null;

  constructor(private readonly options: WorkbenchReloadDirtControllerOptions, private state: WorkbenchReloadDirtControllerState | null = null) {
    this.repository = new WorkbenchGitRepository(options.repoRoot);
  }

  async start() {
    if (!this.state) {
      const sourceState = this.options.activateSourceState?.() ?? this.options.getSourceState();
      const snapshotCommit = await this.writeSnapshot("load reload node graph");
      this.state = {
        baselines: new Map(sourceState.descriptors.map(({ scope }) => [scope, snapshotCommit])),
        descriptors: new Map(sourceState.descriptors.map((descriptor) => [descriptor.scope, descriptor])),
        error: null,
        pendingScopes: [],
        snapshotCommit,
      };
    }
    this.connectInstructionObserver();
    this.watcher = watch(this.options.repoRoot, { recursive: true }, (_event, filename) => {
      if (!filename || this.isObservedPath(String(filename))) this.queueRefresh();
    });
    this.watcher.on("error", (error) => this.publishError(error));
    await this.refresh();
  }

  getSnapshot() {
    return this.snapshot;
  }

  getCatalog() {
    return [...this.requireState().descriptors.values()].map(({ paths: _paths, ...descriptor }) => descriptor);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginReload(scopes: readonly OrchestratorReloadScope[]) {
    const state = this.requireState();
    state.pendingScopes = [...new Set(scopes)];
    state.error = null;
    this.publish({ ...this.snapshot, error: null, pendingScopes: state.pendingScopes });
  }

  async completeReload(requestedScopes: readonly OrchestratorReloadScope[]) {
    await this.enqueue(async () => {
      const state = this.requireState();
      const sourceState = this.options.activateSourceState?.() ?? this.options.getSourceState();
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
      this.connectInstructionObserver();
      await this.refreshNow();
    });
  }

  failReload(error: unknown) {
    this.options.cancelSourceState?.();
    const state = this.requireState();
    state.pendingScopes = [];
    state.error = boundedError(error);
    this.connectInstructionObserver();
    this.publish({ ...this.snapshot, error: state.error, pendingScopes: [] });
  }

  async refresh() {
    await this.enqueue(async () => await this.refreshNow());
    return this.snapshot;
  }

  detachForReload() {
    this.attached = false;
    this.disconnectRuntimeOwners();
    return this.requireState();
  }

  resumeAfterFailedReload() {
    if (this.attached) return;
    this.attached = true;
    this.connectInstructionObserver();
    this.watcher = watch(this.options.repoRoot, { recursive: true }, () => this.queueRefresh());
  }

  dispose() {
    this.attached = false;
    this.disconnectRuntimeOwners();
  }

  private async enqueue(operation: () => Promise<void>) {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    await next;
  }

  private async refreshNow() {
    const state = this.requireState();
    try {
      const currentTree = await this.repository.writeWorktreeTree();
      const dirtyScopes = [] as WorkbenchReloadDirtSnapshot["dirtyScopes"];
      const descriptors = [...state.descriptors.values()].filter(({ paths }) => paths.length);
      const pathsByBaseline = new Map<string, Set<string>>();
      for (const descriptor of descriptors) {
        const baseline = state.baselines.get(descriptor.scope) ?? state.snapshotCommit;
        const paths = pathsByBaseline.get(baseline) ?? new Set<string>();
        for (const sourcePath of descriptor.paths) paths.add(sourcePath);
        pathsByBaseline.set(baseline, paths);
      }
      const changedByBaseline = new Map(await Promise.all([...pathsByBaseline].map(async ([baseline, paths]) => [
        baseline,
        new Set(await this.repository.listChangedPaths(baseline, currentTree, [...paths])),
      ] as const)));
      for (const descriptor of descriptors) {
        const baseline = state.baselines.get(descriptor.scope) ?? state.snapshotCommit;
        const changed = changedByBaseline.get(baseline) ?? new Set<string>();
        if (descriptor.paths.some((sourcePath) => changed.has(sourcePath))) {
          dirtyScopes.push({ description: descriptor.description, destructive: descriptor.destructive, scope: descriptor.scope });
        }
      }
      state.error = null;
      this.publish({ dirtyScopes, error: null, pendingScopes: state.pendingScopes });
    } catch (error) {
      this.publishError(error);
    }
  }

  private async writeSnapshot(message: string) {
    const tree = await this.repository.writeWorktreeTree();
    const previous = this.state?.snapshotCommit ?? await this.repository.readRef(RELOAD_SNAPSHOT_REF) ?? await this.repository.readRef("HEAD");
    if (!previous) throw new Error("Reload dirt snapshots require a usable Git HEAD.");
    const commit = await this.repository.createCommitFromTree(tree, previous, `workbench reload snapshot\n\n${message}`);
    const currentRef = await this.repository.readRef(RELOAD_SNAPSHOT_REF);
    await this.repository.updateRef(RELOAD_SNAPSHOT_REF, commit, currentRef ?? undefined);
    return commit;
  }

  private connectInstructionObserver() {
    this.clearInstructionObserver?.();
    this.clearInstructionObserver = setActiveReloadInstructionObserver((absolutePath) => {
      const sourcePath = this.toWorkspacePath(absolutePath);
      if (!sourcePath) return;
      const state = this.requireState();
      const descriptor = state.descriptors.get("server:instructions");
      if (!descriptor || descriptor.paths.includes(sourcePath)) return;
      state.descriptors.set(descriptor.scope, { ...descriptor, paths: [...descriptor.paths, sourcePath].sort() });
      this.queueRefresh();
    });
  }

  private disconnectRuntimeOwners() {
    this.clearInstructionObserver?.();
    this.clearInstructionObserver = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private isObservedPath(filename: string) {
    const sourcePath = filename.replace(/\\/gu, "/");
    return [...this.requireState().descriptors.values()].some(({ paths }) => paths.includes(sourcePath));
  }

  private toWorkspacePath(absolutePath: string) {
    const relative = path.relative(this.options.repoRoot, absolutePath).replace(/\\/gu, "/");
    return relative && !relative.startsWith("../") ? relative : null;
  }

  private queueRefresh() {
    if (!this.attached || this.refreshQueued) return;
    this.refreshQueued = true;
    setImmediate(() => {
      this.refreshQueued = false;
      void this.refresh();
    });
  }

  private publishError(error: unknown) {
    const state = this.requireState();
    state.error = boundedError(error);
    this.publish({ ...this.snapshot, error: state.error, pendingScopes: state.pendingScopes });
  }

  private publish(snapshot: WorkbenchReloadDirtSnapshot) {
    if (sameSnapshot(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
    if (this.attached) {
      this.options.onChange?.();
      for (const listener of this.listeners) listener();
    }
  }

  private requireState() {
    if (!this.state) throw new Error("Reload dirt controller is not started.");
    return this.state;
  }
}
