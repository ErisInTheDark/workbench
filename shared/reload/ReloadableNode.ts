/*
 * Exports:
 * - ReloadableNodeLifecycle/ReloadableNodeAccess: node replacement and caller-access policies.
 * - ReloadableNodeLease/ReloadableNodeRuntimeDrainPending: generation fencing and bounded drain diagnostics.
 * - ReloadableNodeHandoff: reversible resource transfer, separate from expirable old-work waits.
 * - ReloadableNodeInstance/ReloadableNodeBuild: lifecycle, direct-parent construction and leased operation contracts.
 * - ReloadableNodeOptions/default ReloadableNode: parent-owned node definition with inferred direct-parent access;
 *   source ownership comes from imports plus declared out-of-process entries and non-module assets.
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
  /** Work that survives its admitting request, excluding passive subscriptions. */
  hasPendingWork?(): boolean;
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

export interface ReloadableNodeBuild<
  TObjects extends object,
  TAllowed extends keyof TObjects = keyof TObjects,
> {
  getSourceState(): ReloadDirtSourceState;
  get<TKey extends TAllowed>(key: TKey): TObjects[TKey];
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

export interface ReloadableNodeOptions<
  TContext,
  TObjects extends object,
  TNotification,
  TRequires extends readonly (keyof TObjects)[] = readonly (keyof TObjects)[],
> {
  access: ReloadableNodeAccess;
  destructive?: boolean;
  /** Gitignore patterns for non-module runtime inputs (markdown, scripts, binaries, static assets). */
  assets?: string;
  children: readonly ReloadableNode<TContext, TObjects, TNotification>[];
  create(
    context: TContext,
    build: ReloadableNodeBuild<TObjects, TRequires[number]>,
  ): ReloadableNodeInstance<TObjects, TNotification>;
  description: string;
  /** Absolute paths of modules run outside this process's module graph (workers, child processes, plugins). */
  entries?: readonly string[];
  lifecycle: ReloadableNodeLifecycle;
  provides: readonly (keyof TObjects)[];
  requires: TRequires;
  safeAll: boolean;
  scope: WorkbenchReloadScope;
}

export default class ReloadableNode<TContext, TObjects extends object, TNotification> {
  static define<TContext, TObjects extends object, TNotification>() {
    return <const TRequires extends readonly (keyof TObjects)[]>(
      options: ReloadableNodeOptions<TContext, TObjects, TNotification, TRequires>,
    ) => new ReloadableNode<TContext, TObjects, TNotification>(
      options as ReloadableNodeOptions<TContext, TObjects, TNotification>,
    );
  }

  readonly access: ReloadableNodeAccess;
  readonly assets: string;
  readonly destructive: boolean;
  readonly children: readonly ReloadableNode<TContext, TObjects, TNotification>[];
  readonly create: ReloadableNodeOptions<TContext, TObjects, TNotification>["create"];
  readonly description: string;
  readonly entries: readonly string[];
  readonly lifecycle: ReloadableNodeLifecycle;
  readonly provides: readonly (keyof TObjects)[];
  readonly requires: readonly (keyof TObjects)[];
  readonly safeAll: boolean;
  readonly scope: WorkbenchReloadScope;

  private constructor(options: ReloadableNodeOptions<TContext, TObjects, TNotification>) {
    this.access = options.access;
    this.assets = options.assets ?? "";
    this.destructive = options.destructive ?? false;
    this.children = Object.freeze([...options.children]);
    this.create = options.create;
    this.description = options.description;
    this.entries = Object.freeze([...options.entries ?? []]);
    this.lifecycle = options.lifecycle;
    this.provides = Object.freeze([...options.provides]);
    this.requires = Object.freeze([...options.requires]);
    this.safeAll = options.safeAll;
    this.scope = options.scope;
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
