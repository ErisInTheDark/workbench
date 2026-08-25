/*
 * Exports:
 * - ReloadableNodeLifecycle/ReloadableNodeAccess: node replacement and caller-access policies. Keywords: reload, lifecycle, access.
 * - ReloadableNodeLease/ReloadableNodeRuntimeDrainPending: generation fencing and bounded drain diagnostics. Keywords: lease, drain, diagnostics.
 * - ReloadableNodeInstance/ReloadableNodeBuild: runtime registration and construction contracts. Keywords: registry, factory, handoff.
 * - ReloadableNodeOptions/default ReloadableNode: parent-owned reloadable node definition. Keywords: graph, children, scope, sources.
 * - ReloadableNodeGraph/defineReloadableNodeGraph: direct-root graph definition loaded by the stable host. Keywords: roots, topology, loader.
 */
import type { OrchestratorReloadScope } from "../lib/types";

export type ReloadableNodeLifecycle = "atomic" | "handoff";
export type ReloadableNodeAccess = "agent" | "cli" | "operator";

export interface ReloadableNodeLease {
  isCurrent(): boolean;
}

export interface ReloadableNodeRuntimeDrainPending {
  ageMs: number;
  label: string;
}

export interface ReloadableNodeInstance<TObjects extends object, TNotification> {
  activate?(): Promise<void> | void;
  beginRuntimeDrain?(): void;
  detachForReload?(replacement: { isReplacing(scope: string): boolean }): Promise<unknown> | unknown;
  dispose(reportPhase?: (phase: string) => void): Promise<void> | void;
  expireRuntimeDrain?(): void;
  listRuntimeDrainPending?(): readonly ReloadableNodeRuntimeDrainPending[];
  observeProviderNotification?(notification: TNotification): Promise<void> | void;
  registrations: Partial<TObjects>;
  start(): Promise<void> | void;
}

export interface ReloadableNodeBuild<TObjects extends object> {
  get<TKey extends keyof TObjects>(key: TKey): TObjects[TKey];
  handoffState: unknown;
  isReplacing(scope: string): boolean;
  lease: ReloadableNodeLease;
  mode: "initial" | "replacement" | "restore";
}

export interface ReloadableNodeOptions<TContext, TObjects extends object, TNotification> {
  access: ReloadableNodeAccess;
  children: readonly ReloadableNode<TContext, TObjects, TNotification>[];
  create(context: TContext, build: ReloadableNodeBuild<TObjects>): ReloadableNodeInstance<TObjects, TNotification>;
  description: string;
  lifecycle: ReloadableNodeLifecycle;
  provides: readonly (keyof TObjects)[];
  requires: readonly (keyof TObjects)[];
  safeAll: boolean;
  scope: OrchestratorReloadScope;
  sources: string;
}

export default class ReloadableNode<TContext, TObjects extends object, TNotification> {
  readonly access: ReloadableNodeAccess;
  readonly children: readonly ReloadableNode<TContext, TObjects, TNotification>[];
  readonly create: ReloadableNodeOptions<TContext, TObjects, TNotification>["create"];
  readonly description: string;
  readonly lifecycle: ReloadableNodeLifecycle;
  readonly provides: readonly (keyof TObjects)[];
  readonly requires: readonly (keyof TObjects)[];
  readonly safeAll: boolean;
  readonly scope: OrchestratorReloadScope;
  readonly sources: string;

  constructor(options: ReloadableNodeOptions<TContext, TObjects, TNotification>) {
    this.access = options.access;
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
}

export function defineReloadableNodeGraph<TContext, TObjects extends object, TNotification>(
  roots: readonly ReloadableNode<TContext, TObjects, TNotification>[],
): ReloadableNodeGraph<TContext, TObjects, TNotification> {
  return Object.freeze({ roots: Object.freeze([...roots]) });
}
