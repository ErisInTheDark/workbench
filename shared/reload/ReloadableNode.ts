/*
 * Exports:
 * - ReloadableNodeLifecycle/ReloadableNodeAccess: node replacement and caller-access policies.
 * - ReloadableNodeLease/ReloadableNodeRuntimeDrainPending: generation fencing and bounded drain diagnostics.
 * - ReloadableNodeHandoff: reversible resource transfer, separate from expirable old-work waits.
 * - ReloadableNodeInstance/ReloadableNodeBuild: lifecycle, direct-parent construction and leased operation contracts.
 * - ReloadableNodeOptions/default ReloadableNode: parent-owned node definition with hostile-boundary sources.
 * - ReloadableNodeGraph/defineReloadableNodeGraph: direct-root graph definition loaded by the stable host.
 * - ReloadableNodeSourceObservation/ReloadableNodeSourceMetadata: scoped observations and discovered generation sources.
 */
import type { WorkbenchReloadScope } from "./workbench-reload.ts";
import type { ReloadDirtSourceState } from "./ReloadDirtController.ts";

export type ReloadableNodeLifecycle = "atomic" | "handoff";
export type ReloadableNodeAccess = "agent" | "cli" | "operator";

export interface ReloadableNodeLease {
  isCurrent(): boolean;
}

export interface ReloadableNodeRuntimeDrainPending {
  ageMs: number;
  label: string;
}

export interface ReloadableNodeHandoff {
  waitForIdle(): Promise<void>;
  expire(): void;
  detach(): Promise<unknown> | unknown;
  resume(): Promise<void> | void;
  commit(): Promise<void> | void;
}

export interface ReloadableNodeInstance<TObjects extends object, TNotification> {
  activate?(): Promise<void> | void;
  deactivate?(): Promise<void> | void;
  afterCommit?(): void;
  beginHandoff?(replacement: { isReplacing(scope: string): boolean }): ReloadableNodeHandoff;
  beginRuntimeDrain?(): void;
  captureReloadState?(): unknown;
  detachForReload?(replacement: { isReplacing(scope: string): boolean }): Promise<unknown> | unknown;
  dispose(reportPhase?: (phase: string) => void): Promise<void> | void;
  expireRuntimeDrain?(): void;
  listRuntimeDrainPending?(): readonly ReloadableNodeRuntimeDrainPending[];
  observeProviderNotification?(notification: TNotification): Promise<void> | void;
  registrations: Partial<TObjects>;
  shutdown?(): Promise<void> | void;
  start(reportPhase?: (phase: string) => void, signal?: AbortSignal): Promise<void> | void;
}

export interface ReloadableNodeBuild<TObjects extends object> {
  getSourceState(): ReloadDirtSourceState;
  get<TKey extends keyof TObjects>(key: TKey): TObjects[TKey];
  run<TKey extends keyof TObjects, TResult>(
    key: TKey,
    operation: (feature: TObjects[TKey]) => Promise<TResult> | TResult,
    label?: string,
  ): Promise<TResult>;
  handoffState: unknown;
  isReplacing(scope: string): boolean;
  lease: ReloadableNodeLease;
  mode: "initial" | "replacement" | "restore";
}

export interface ReloadableNodeOptions<TContext, TObjects extends object, TNotification> {
  access: ReloadableNodeAccess;
  destructive?: boolean;
  boundarySources?: string;
  children: readonly ReloadableNode<TContext, TObjects, TNotification>[];
  create(context: TContext, build: ReloadableNodeBuild<TObjects>): ReloadableNodeInstance<TObjects, TNotification>;
  description: string;
  lifecycle: ReloadableNodeLifecycle;
  provides: readonly (keyof TObjects)[];
  requires: readonly (keyof TObjects)[];
  safeAll: boolean;
  scope: WorkbenchReloadScope;
  sources: string;
}

export default class ReloadableNode<TContext, TObjects extends object, TNotification> {
  readonly access: ReloadableNodeAccess;
  readonly destructive: boolean;
  readonly boundarySources: string;
  readonly children: readonly ReloadableNode<TContext, TObjects, TNotification>[];
  readonly create: ReloadableNodeOptions<TContext, TObjects, TNotification>["create"];
  readonly description: string;
  readonly lifecycle: ReloadableNodeLifecycle;
  readonly provides: readonly (keyof TObjects)[];
  readonly requires: readonly (keyof TObjects)[];
  readonly safeAll: boolean;
  readonly scope: WorkbenchReloadScope;
  readonly sources: string;

  constructor(options: ReloadableNodeOptions<TContext, TObjects, TNotification>) {
    this.access = options.access;
    this.destructive = options.destructive ?? false;
    this.boundarySources = options.boundarySources ?? "";
    this.children = Object.freeze([...options.children]);
    this.create = options.create;
    this.description = options.description;
    this.lifecycle = options.lifecycle;
    this.provides = Object.freeze([...options.provides]);
    this.requires = Object.freeze([...options.requires]);
    this.safeAll = options.safeAll;
    this.scope = options.scope;
    this.sources = options.sources;
  }
}

export interface ReloadableNodeGraph<TContext, TObjects extends object, TNotification> {
  roots: readonly ReloadableNode<TContext, TObjects, TNotification>[];
  sourceObservations?: readonly ReloadableNodeSourceObservation[];
  sourceMetadata?: ReloadableNodeSourceMetadata;
}

export interface ReloadableNodeSourceObservation {
  scope: WorkbenchReloadScope;
  path: string;
}

export interface ReloadableNodeSourceMetadata {
  pathsByScope: ReadonlyMap<WorkbenchReloadScope, readonly string[]>;
  topologyPaths: readonly string[];
  processPaths: readonly string[];
}

export function defineReloadableNodeGraph<TContext, TObjects extends object, TNotification>(
  roots: readonly ReloadableNode<TContext, TObjects, TNotification>[],
  sourceObservations: readonly ReloadableNodeSourceObservation[] = [],
): ReloadableNodeGraph<TContext, TObjects, TNotification> {
  return Object.freeze({ roots: Object.freeze([...roots]), sourceObservations: Object.freeze([...sourceObservations]) });
}
