/*
 * Exports:
 * - WorkbenchAppReloadDirtControllerState: transferable dirt, pending batch, and source generations. Keywords: reload, handoff, watcher.
 * - default WorkbenchAppReloadDirtController: map source events to app scopes without owning graph execution. Keywords: reload, dirt, app.
 */
import { watch, type FSWatcher } from "node:fs";

import type {
  WorkbenchReloadDirtSnapshot,
  WorkbenchReloadScope,
  WorkbenchReloadScopeDescriptor,
} from "workbench-shared/reload/workbench-reload";

const MAX_ERROR_LENGTH = 500;

export interface WorkbenchAppReloadDirtControllerState {
  dirtyGenerations: Map<WorkbenchReloadScope, number>;
  error: string | null;
  generation: number;
  pendingGenerations: Map<WorkbenchReloadScope, number>;
  pendingScopes: WorkbenchReloadScope[];
}

export interface WorkbenchAppReloadDirtControllerOptions {
  getCatalog(): readonly WorkbenchReloadScopeDescriptor[];
  getScopesForPaths(paths: readonly string[]): WorkbenchReloadScope[];
  onChange?(): void;
  repositoryRootPath: string;
  watchSource?: typeof watch;
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

export default class WorkbenchAppReloadDirtController {
  private attached = true;
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkbenchReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };
  private readonly state: WorkbenchAppReloadDirtControllerState;
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly options: WorkbenchAppReloadDirtControllerOptions,
    state?: WorkbenchAppReloadDirtControllerState,
  ) {
    this.state = state ?? {
      dirtyGenerations: new Map(),
      error: null,
      generation: 0,
      pendingGenerations: new Map(),
      pendingScopes: [],
    };
  }

  start() {
    if (this.watcher) throw new Error("Workbench app reload dirt is already watching.");
    this.watcher = (this.options.watchSource ?? watch)(
      this.options.repositoryRootPath,
      { recursive: true },
      (_event, filename) => this.observePath(filename ? String(filename).replace(/\\/gu, "/") : null),
    );
    this.watcher.on("error", (error) => this.publishError(error));
    this.publishCurrent();
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginReload(scopes: readonly WorkbenchReloadScope[]) {
    const selected = [...new Set(scopes)];
    this.state.pendingScopes = selected;
    this.state.pendingGenerations = new Map(selected.map((scope) => [
      scope,
      this.state.dirtyGenerations.get(scope) ?? this.state.generation,
    ]));
    this.state.error = null;
    this.publishCurrent();
  }

  completeReload(appliedScopes: readonly WorkbenchReloadScope[]) {
    for (const scope of appliedScopes) {
      const admittedGeneration = this.state.pendingGenerations.get(scope);
      if (admittedGeneration === undefined) continue;
      if ((this.state.dirtyGenerations.get(scope) ?? admittedGeneration) === admittedGeneration) {
        this.state.dirtyGenerations.delete(scope);
      }
    }
    this.state.pendingScopes = [];
    this.state.pendingGenerations.clear();
    this.state.error = null;
    this.publishCurrent();
  }

  failReload(error: unknown) {
    this.state.pendingScopes = [];
    this.state.pendingGenerations.clear();
    this.state.error = boundedError(error);
    this.publishCurrent();
  }

  detachForReload() {
    this.attached = false;
    this.watcher?.close();
    this.watcher = null;
    return this.state;
  }

  dispose() {
    this.attached = false;
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }

  private observePath(sourcePath: string | null) {
    const catalog = this.options.getCatalog();
    const scopes = sourcePath
      ? this.options.getScopesForPaths([sourcePath])
      : catalog.map(({ scope }) => scope);
    if (!scopes.length) return;
    this.state.generation += 1;
    for (const scope of scopes) this.state.dirtyGenerations.set(scope, this.state.generation);
    this.publishCurrent();
  }

  private publishError(error: unknown) {
    this.state.error = boundedError(error);
    this.publishCurrent();
  }

  private publishCurrent() {
    const catalog = this.options.getCatalog();
    const descriptors = new Map(catalog.map((descriptor) => [descriptor.scope, descriptor]));
    const dirtyScopes = catalog.flatMap((descriptor) => this.state.dirtyGenerations.has(descriptor.scope)
      ? [{
        description: descriptor.description,
        destructive: descriptor.destructive === true,
        scope: descriptor.scope,
      }]
      : []);
    const next = {
      dirtyScopes,
      error: this.state.error,
      pendingScopes: this.state.pendingScopes.filter((scope) => descriptors.has(scope)),
    };
    if (sameSnapshot(this.snapshot, next)) return;
    this.snapshot = next;
    if (!this.attached) return;
    this.options.onChange?.();
    for (const listener of this.listeners) listener();
  }
}
