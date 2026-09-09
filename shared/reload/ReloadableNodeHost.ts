/*
 * Keywords: graph, reload, registry, handoff, rollback, deadline.
 * Exports:
 * - ReloadableNodeModuleLoader: load fresh parent-owned graph definitions.
 * - ReloadableNodeHostOptions: process-owned deadline, clock, logging, and swap ports.
 * - default ReloadableNodeHost: validate topology, lease dependencies, and replace node closures.
 */
import { createGitignoreMatcher, type GitignoreMatcher } from "../source-pattern-matcher.ts";
import type {
  WorkbenchReloadScope as OrchestratorReloadScope,
  WorkbenchReloadScopeDescriptor as OrchestratorReloadScopeDescriptor,
} from "./workbench-reload.ts";
import type ReloadableNode from "./ReloadableNode.ts";
import ReloadableNodeTransition, { type ReloadableNodeTransitionDeadline } from "./ReloadableNodeTransition.ts";
import type {
  ReloadableNodeBuild,
  ReloadableNodeGraph,
  ReloadableNodeHandoff,
  ReloadableNodeInstance,
  ReloadableNodeLifecycle,
} from "./ReloadableNode.ts";

interface OrchestratorFeatureNodeDefinition<TContext, TFeatures extends object, TNotification> {
  access: ReloadableNode<TContext, TFeatures, TNotification>["access"];
  create(context: TContext, build: ReloadableNodeBuild<TFeatures>): ReloadableNodeInstance<TFeatures, TNotification>;
  dependencies: readonly string[];
  description: string;
  featureKeys: readonly (keyof TFeatures)[];
  id: string;
  lifecycle: ReloadableNodeLifecycle;
  matcher: GitignoreMatcher;
  requires: readonly (keyof TFeatures)[];
  safeAll: boolean;
  scope: OrchestratorReloadScope;
}

export interface ReloadableNodeModuleLoader<TContext, TFeatures extends object, TNotification> {
  load(): ReloadableNodeGraph<TContext, TFeatures, TNotification>;
  reload(): ReloadableNodeGraph<TContext, TFeatures, TNotification>;
}

export interface ReloadableNodeHostOptions {
  createRuntimeDrainDeadline?: (timeoutMs: number) => ReloadableNodeTransitionDeadline;
  logError?: (message: string) => void;
  now?: () => number;
  onSwap?: (nodeIds: readonly string[]) => Promise<void> | void;
  processScope?: {
    descriptor: OrchestratorReloadScopeDescriptor;
    sources: string;
  };
  requiredRegistrations?: readonly PropertyKey[];
  requiredScopes?: readonly OrchestratorReloadScope[];
  runtimeDrainTimeoutMs?: number;
  topologyScope?: OrchestratorReloadScope;
}

interface ActiveOperation {
  label: string;
  startedAt: number;
}

interface ActiveNode<TContext, TFeatures extends object, TNotification> {
  activeOperations: Map<symbol, ActiveOperation>;
  definition: OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>;
  disposalPhase: string | null;
  drainWaiters: Array<() => void>;
  gate: Promise<void> | null;
  instance: ReloadableNodeInstance<TFeatures, TNotification>;
  releaseGate: (() => void) | null;
  runtimeDrainStartedAt: number | null;
  token: symbol;
  startController: AbortController;
  drainExpired: boolean;
}

interface PendingRollback<TContext, TFeatures extends object, TNotification> {
  nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[];
  handoffs: Map<string, ReloadableNodeHandoff>;
  error: Error;
}

interface Retirement<TContext, TFeatures extends object, TNotification> {
  nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[];
  promise: Promise<void>;
}

const DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS = 30_000;
function boundedLabel(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim() || "unnamed operation";
  return normalized.length > 200 ? `${normalized.slice(0, 197).trimEnd()}...` : normalized;
}

function createRuntimeDrainDeadline(timeoutMs: number): ReloadableNodeTransitionDeadline {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return {
    cancel: () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    },
    expired,
  };
}

function normalizeNodeId(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized !== value) throw new Error(`${label} must be a canonical non-empty value.`);
  return normalized;
}

export default class ReloadableNodeHost<TContext, TFeatures extends object, TNotification> {
  private readonly createDeadline: NonNullable<ReloadableNodeHostOptions["createRuntimeDrainDeadline"]>;
  private definitions = new Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>();
  private featureOwners = new Map<keyof TFeatures, string>();
  private hardShutdownStarted = false;
  private hardShutdownPromise: Promise<void> | null = null;
  private readonly logError: NonNullable<ReloadableNodeHostOptions["logError"]>;
  private readonly now: NonNullable<ReloadableNodeHostOptions["now"]>;
  private readonly onSwap: NonNullable<ReloadableNodeHostOptions["onSwap"]>;
  private readonly processScope: ReloadableNodeHostOptions["processScope"];
  private readonly processSourceMatcher: GitignoreMatcher | null;
  private readonly requiredRegistrations: readonly PropertyKey[];
  private readonly requiredScopes: readonly OrchestratorReloadScope[];
  private nodes = new Map<string, ActiveNode<TContext, TFeatures, TNotification>>();
  private readonly candidates = new Map<string, ActiveNode<TContext, TFeatures, TNotification>>();
  private reloadTail = Promise.resolve();
  private readonly pendingRollbacks = new Set<PendingRollback<TContext, TFeatures, TNotification>>();
  private readonly retirements = new Set<Retirement<TContext, TFeatures, TNotification>>();
  private readonly runtimeDrainTimeoutMs: number;
  private started = false;
  private starting: Promise<void> | null = null;
  private topology: readonly OrchestratorReloadScope[] = [];
  private readonly topologyScope: OrchestratorReloadScope;

  constructor(
    private readonly context: TContext,
    private readonly loader: ReloadableNodeModuleLoader<TContext, TFeatures, TNotification>,
    options: ReloadableNodeHostOptions = {},
  ) {
    this.createDeadline = options.createRuntimeDrainDeadline ?? createRuntimeDrainDeadline;
    this.logError = options.logError ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.onSwap = options.onSwap ?? (() => undefined);
    this.processScope = options.processScope;
    this.processSourceMatcher = options.processScope
      ? createGitignoreMatcher(options.processScope.sources)
      : null;
    this.requiredRegistrations = options.requiredRegistrations ?? [];
    this.requiredScopes = options.requiredScopes ?? [];
    this.runtimeDrainTimeoutMs = options.runtimeDrainTimeoutMs ?? DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS;
    this.topologyScope = options.topologyScope
      ?? (() => { throw new Error("A reloadable graph topology scope is required."); })();
    const graph = this.validateGraph(this.flattenGraph(loader.load()));
    this.definitions = graph.definitions;
    this.topology = graph.topology;
    this.nodes = this.createNodes(graph.definitions, graph.topology, new Map(), new Map(), new Set(), "initial");
    this.featureOwners = this.validateFeatureOwnership(this.nodes);
  }

  get<TKey extends keyof TFeatures>(key: TKey) {
    return this.requireFeature(this.nodes, this.featureOwners, key);
  }

  getReloadScopeCatalog(): readonly OrchestratorReloadScopeDescriptor[] {
    const graph = this.topology.map((scope) => {
      const definition = this.definitions.get(scope)!;
      return Object.freeze({
        access: definition.access,
        description: definition.description,
        safeAll: definition.safeAll,
        scope: definition.scope,
      });
    });
    return this.processScope ? [...graph, this.processScope.descriptor] : graph;
  }

  getReloadScopesForPaths(paths: readonly string[]): OrchestratorReloadScope[] {
    const scopes = this.topology.filter((scope) => {
      const matcher = this.definitions.get(scope)!.matcher;
      return paths.some((path) => matcher.matchesPathOrDescendant(path));
    });
    if (
      this.processScope
      && this.processSourceMatcher
      && paths.some((path) => this.processSourceMatcher!.matchesPathOrDescendant(path))
    ) scopes.push(this.processScope.descriptor.scope);
    return scopes;
  }

  getDependantClosure(scopes: readonly OrchestratorReloadScope[]) {
    const selected = this.selectDependants(scopes, this.definitions);
    return this.topology.filter((scope) => selected.has(scope));
  }

  async run<TKey extends keyof TFeatures, TResult>(
    key: TKey,
    operation: (feature: TFeatures[TKey]) => Promise<TResult> | TResult,
    label = String(key),
  ) {
    this.assertAcceptingWork();
    while (true) {
      const ownerId = this.requireFeatureOwner(key);
      await this.waitForOpenDependencyChain(ownerId);
      this.assertAcceptingWork();
      if (this.requireFeatureOwner(key) !== ownerId) continue;
      const leased = this.dependencyClosure(ownerId).map((nodeId) => this.requireNode(nodeId));
      if (leased.some((node) => node.gate)) continue;
      const token = Symbol("workbench-reloadable-operation");
      const activeOperation = { label: boundedLabel(label), startedAt: this.now() };
      for (const node of leased) node.activeOperations.set(token, activeOperation);
      try {
        const owner = this.requireNode(ownerId);
        return await operation(owner.instance.registrations[key] as TFeatures[TKey]);
      } finally {
        for (const node of leased) {
          node.activeOperations.delete(token);
          this.resolveDrain(node);
        }
      }
    }
  }

  start() {
    this.assertAcceptingWork();
    if (this.started) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting = this.startGraph();
    this.starting = starting;
    void starting.then(
      () => { if (this.starting === starting) this.starting = null; },
      () => { if (this.starting === starting) this.starting = null; },
    );
    return starting;
  }

  private async startGraph() {
    const started: ActiveNode<TContext, TFeatures, TNotification>[] = [];
    try {
      for (const nodeId of this.topology) {
        this.assertAcceptingWork();
        const node = this.requireNode(nodeId);
        started.push(node);
        await node.instance.start(undefined, node.startController.signal);
        node.startController.signal.throwIfAborted();
      }
      for (const node of started) {
        this.assertAcceptingWork();
        await node.instance.activate?.();
      }
      this.assertAcceptingWork();
      this.started = true;
      for (const node of started) node.instance.afterCommit?.();
    } catch (error) {
      await this.disposeNodesAfterFailure([...started].reverse(), error, "Feature graph startup and cleanup both failed.");
    }
  }

  validateReloadScopes(scopes: readonly OrchestratorReloadScope[]) {
    this.selectDependants(scopes, this.definitions);
  }

  async reload(scopes: readonly OrchestratorReloadScope[]) {
    this.assertAcceptingWork();
    const operation = this.reloadTail.then(async () => {
      this.assertAcceptingWork();
      const transition = new ReloadableNodeTransition(
        this.createDeadline(this.runtimeDrainTimeoutMs),
        this.runtimeDrainTimeoutMs,
        () => this.describeNodes([
          ...this.nodes.values(),
          ...Array.from(this.retirements).flatMap((retirement) => retirement.nodes),
        ], "Pending reload work"),
        this.logError,
      );
      try {
        const fresh = await transition.step("load graph", () => this.validateGraph(this.flattenGraph(this.loader.reload())));
        const topologyChanged = this.hasTopologyChanged(fresh.definitions, fresh.topology);
        if (topologyChanged && !scopes.includes(this.topologyScope)) {
          throw new Error(`Reloadable node topology changed outside a ${this.topologyScope} reload. The current runtime was not changed.`);
        }
        const selected = topologyChanged
          ? this.changedTopologyClosure(fresh.definitions, scopes)
          : this.selectDependants(scopes, fresh.definitions);
        await this.retryRollbacks(selected, transition);
        if (selected.size) await this.replaceGraph(fresh.definitions, fresh.topology, selected, transition);
      } finally {
        transition.finish();
      }
    });
    this.reloadTail = operation.catch(() => undefined);
    return await operation;
  }

  async observeProviderNotification(notification: TNotification, label = "provider notification") {
    if (this.hardShutdownStarted) return;
    const observerIds = this.topology.filter((nodeId) => this.requireNode(nodeId).instance.observeProviderNotification);
    for (const nodeId of observerIds) {
      await this.waitForOpenDependencyChain(nodeId);
      if (this.hardShutdownStarted) return;
      const leased = this.dependencyClosure(nodeId).map((dependencyId) => this.requireNode(dependencyId));
      const token = Symbol("workbench-provider-notification");
      const activeOperation = { label: boundedLabel(label), startedAt: this.now() };
      for (const node of leased) node.activeOperations.set(token, activeOperation);
      try {
        await this.requireNode(nodeId).instance.observeProviderNotification?.(notification);
      } finally {
        for (const node of leased) {
          node.activeOperations.delete(token);
          this.resolveDrain(node);
        }
      }
    }
  }

  dispose() {
    return this.beginHardShutdown();
  }

  beginHardShutdown() {
    if (this.hardShutdownPromise) return this.hardShutdownPromise;
    this.hardShutdownStarted = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.hardShutdownPromise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    const reason = new Error("Reloadable graph is shutting down.");
    const notified = new Set<ActiveNode<TContext, TFeatures, TNotification>>();
    const shutdowns: Promise<void>[] = [];
    const notify = (node: ActiveNode<TContext, TFeatures, TNotification>) => {
      if (notified.has(node)) return;
      notified.add(node);
      node.startController.abort(reason);
      this.openGate(node);
      for (const operation of [
        () => this.beginDrain(node),
        () => node.instance.expireRuntimeDrain?.(),
        () => node.instance.shutdown?.(),
      ]) {
        try { shutdowns.push(Promise.resolve(operation())); }
        catch (error) { shutdowns.push(Promise.reject(error)); }
      }
    };
    for (const node of this.nodes.values()) notify(node);
    for (const node of this.candidates.values()) notify(node);
    for (const retirement of this.retirements) for (const node of retirement.nodes) notify(node);
    // Observe early failures immediately, while all owners receive their stop intent.
    const early = Promise.allSettled(shutdowns);
    const starting = this.starting;
    void (async () => {
      const errors: unknown[] = [];
      if (starting) {
        try { await starting; }
        catch (error) {
          if (error !== reason) this.reportLifecycleFailure("feature graph", "startup while closing", error);
        }
      }
      await this.reloadTail;
      const earlyResults = await early;
      const earlyCount = shutdowns.length;
      const nodes = [...this.topology].reverse().map((nodeId) => this.requireNode(nodeId));
      const retirements = [...this.retirements];
      for (const node of nodes) notify(node);
      for (const retirement of retirements) for (const node of retirement.nodes) notify(node);
      for (const result of [
        ...earlyResults,
        ...await Promise.allSettled(shutdowns.slice(earlyCount)),
        ...await Promise.allSettled(retirements.map(retirement => retirement.promise)),
      ]) if (result.status === "rejected") errors.push(result.reason);
      try { await this.disposeNodes(nodes); }
      catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Feature graph shutdown failed.");
    })().then(resolve, reject);
    return this.hardShutdownPromise;
  }

  private async replaceGraph(
    definitions: Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    topology: readonly OrchestratorReloadScope[],
    selected: ReadonlySet<string>,
    transition: ReloadableNodeTransition,
  ) {
    const previousGraph = this.nodes;
    const previousDefinitions = this.definitions;
    const previousTopology = this.topology;
    const previousOwners = this.featureOwners;
    const previous = previousTopology.filter((id) => selected.has(id)).map((id) => this.requireNode(id));
    const ordered = topology.filter((id) => selected.has(id));
    const retained = new Map(previousGraph);
    const handoffs = new Map<string, ReloadableNodeHandoff>();
    const states = new Map<string, unknown>();
    for (const node of previous) {
      const id = node.definition.id;
      retained.delete(id);
      if (node.definition.lifecycle === "handoff" && !node.instance.beginHandoff) {
        throw new Error(`Reloadable node ${id} does not support reversible handoff; the current branch was not changed.`);
      }
    }
    const candidates = this.candidates;
    const activated: ActiveNode<TContext, TFeatures, TNotification>[] = [];
    try {
      for (const node of previous) {
        const id = node.definition.id;
        node.drainExpired = false;
        if (this.started) states.set(id, node.instance.captureReloadState?.());
        if (node.definition.lifecycle === "handoff") {
          handoffs.set(id, node.instance.beginHandoff!({ isReplacing: (scope) => selected.has(scope) }));
        }
      }
      if (handoffs.size) {
        for (const node of previous) this.closeGate(node);
        await transition.drain("feature graph: drain", async () => {
          await Promise.all([
            ...previous.map((node) => this.waitForDrain(node)),
            ...[...handoffs.values()].map((handoff) => handoff.waitForIdle()),
          ]);
        }, () => {
          for (const node of previous) {
            const handoff = handoffs.get(node.definition.id);
            if (handoff) this.expireDrain(node, handoff);
          }
        });
        for (const node of [...previous].reverse()) {
          const handoff = handoffs.get(node.definition.id);
          if (handoff) states.set(node.definition.id, await transition.step(`${node.definition.id}: detach`, () => handoff.detach()));
        }
      }
      this.assertAcceptingWork();
      this.createNodes(definitions, ordered, retained, states, selected, "replacement", candidates);
      if (this.started) {
        for (const id of ordered) {
          const node = candidates.get(id)!;
          await transition.step(`${id}: start`, (reportPhase) => node.instance.start(reportPhase, node.startController.signal));
          this.assertAcceptingWork();
        }
      }
      const nextGraph = new Map([...retained, ...candidates]);
      const nextOwners = this.validateFeatureOwnership(nextGraph);
      for (const node of candidates.values()) this.closeGate(node);
      this.nodes = nextGraph;
      this.definitions = definitions;
      this.topology = topology;
      this.featureOwners = nextOwners;
      for (const id of ordered) {
        const node = candidates.get(id)!;
        activated.push(node);
        await transition.step(`${id}: activate`, () => node.instance.activate?.());
        this.assertAcceptingWork();
      }
    } catch (error) {
      this.nodes = previousGraph;
      this.definitions = previousDefinitions;
      this.topology = previousTopology;
      this.featureOwners = previousOwners;
      for (const node of candidates.values()) node.startController.abort(error);
      const failures: unknown[] = [error];
      for (const node of activated.reverse()) {
        try { await transition.step(`${node.definition.id}: deactivate`, () => node.instance.deactivate?.()); }
        catch (failure) { failures.push(failure); }
      }
      for (const node of [...candidates.values()].reverse()) {
        try { await transition.step(`${node.definition.id}: discard`, (reportPhase) => node.instance.dispose(reportPhase)); }
        catch (failure) { failures.push(failure); }
        this.openGate(node);
      }
      const failedHandoffs = new Map<string, ReloadableNodeHandoff>();
      for (const [id, handoff] of handoffs) {
        try { await transition.step(`${id}: resume`, () => handoff.resume()); }
        catch (failure) {
          failures.push(failure);
          failedHandoffs.set(id, handoff);
        }
      }
      const failure = failures.length === 1 ? error : new AggregateError(failures, "Branch replacement failed during rollback.");
      if (failedHandoffs.size) {
        this.pendingRollbacks.add({
          nodes: previous,
          handoffs: failedHandoffs,
          error: failure instanceof Error ? failure : new Error("Branch rollback requires resource recovery."),
        });
      }
      for (const node of previous) this.openGate(node);
      candidates.clear();
      throw failure;
    }
    for (const node of [...previous, ...candidates.values()]) this.openGate(node);
    for (const node of candidates.values()) {
      try { node.instance.afterCommit?.(); }
      catch (error) { this.reportLifecycleFailure(node.definition.id, "post-commit startup", error); }
    }
    candidates.clear();
    try { await this.onSwap(ordered); }
    catch (error) { this.reportLifecycleFailure("feature graph", "swap notification", error); }
    await this.retireNodes([...previous].reverse(), handoffs, transition);
  }

  private async retryRollbacks(selected: ReadonlySet<string>, transition: ReloadableNodeTransition) {
    for (const rollback of this.pendingRollbacks) {
      if (!rollback.nodes.some((node) => selected.has(node.definition.id))) continue;
      const failures: unknown[] = [];
      for (const [id, handoff] of rollback.handoffs) {
        try {
          await transition.step(`${id}: retry rollback`, () => handoff.resume());
          rollback.handoffs.delete(id);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        rollback.error = new AggregateError(failures, "Retained branch resources are still unavailable.");
        throw rollback.error;
      }
      for (const node of rollback.nodes) this.openGate(node);
      this.pendingRollbacks.delete(rollback);
    }
  }

  private reportLifecycleFailure(scope: string, phase: string, error: unknown) {
    this.logError(`${scope}: ${phase} failed: ${error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 500) : "non-Error rejection"}`);
  }

  private createNodes(
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    ordered: readonly string[],
    dependencies: ReadonlyMap<string, ActiveNode<TContext, TFeatures, TNotification>>,
    handoffStates: ReadonlyMap<string, unknown>,
    selected: ReadonlySet<string>,
    mode: ReloadableNodeBuild<TFeatures>["mode"],
    created = new Map<string, ActiveNode<TContext, TFeatures, TNotification>>(),
  ) {
    for (const nodeId of ordered) {
      const definition = definitions.get(nodeId)!;
      const token = Symbol(`workbench-feature-node:${nodeId}`);
      const visible = new Map([...dependencies, ...created]);
      const instance = definition.create(this.context, {
        get: <TKey extends keyof TFeatures>(key: TKey) => {
          if (!definition.requires.includes(key)) throw new Error(`Reloadable node ${nodeId} read undeclared parent registration ${String(key)}.`);
          return this.requireFeature(visible, this.validateFeatureOwnership(visible), key);
        },
        handoffState: handoffStates.get(nodeId),
        isReplacing: (candidateId) => selected.has(candidateId),
        lease: { isCurrent: () => !this.hardShutdownStarted && !this.isUnavailable(nodeId) && this.nodes.get(nodeId)?.token === token },
        mode,
      });
      created.set(nodeId, {
        activeOperations: new Map(), definition, disposalPhase: null, drainWaiters: [], gate: null,
        instance, releaseGate: null, runtimeDrainStartedAt: null, token, startController: new AbortController(), drainExpired: false,
      });
      const actualKeys = Object.keys(instance.registrations) as (keyof TFeatures)[];
      if (actualKeys.length !== definition.featureKeys.length || actualKeys.some((key) => !definition.featureKeys.includes(key))) {
        throw new Error(`Feature node ${nodeId} did not create exactly its declared feature keys.`);
      }
    }
    return created;
  }

  private flattenGraph(graph: ReloadableNodeGraph<TContext, TFeatures, TNotification>) {
    if (!graph.roots.length) throw new Error("At least one reloadable root node is required.");
    const nodes = new Map<string, ReloadableNode<TContext, TFeatures, TNotification>>();
    const parents = new Map<string, Set<string>>();
    const visit = (node: ReloadableNode<TContext, TFeatures, TNotification>, parentScope: string | null) => {
      const scope = normalizeNodeId(node.scope, "Reloadable node scope");
      const existing = nodes.get(scope);
      if (existing && existing !== node) {
        throw new Error(`Reloadable scope ${scope} is represented by different child node objects.`);
      }
      nodes.set(scope, node);
      if (parentScope) {
        const nodeParents = parents.get(scope) ?? new Set<string>();
        nodeParents.add(parentScope);
        parents.set(scope, nodeParents);
      }
      if (existing) return;
      for (const child of node.children) visit(child, scope);
    };
    for (const root of graph.roots) visit(root, null);
    return [...nodes.values()].map((node): OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification> => ({
      access: node.access,
      create: node.create,
      dependencies: [...(parents.get(node.scope) ?? [])],
      description: node.description,
      featureKeys: node.provides,
      id: node.scope,
      lifecycle: node.lifecycle,
      matcher: createGitignoreMatcher(node.sources),
      requires: node.requires,
      safeAll: node.safeAll,
      scope: node.scope,
    }));
  }

  private validateGraph(definitions: readonly OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>[]) {
    if (!definitions.length) throw new Error("At least one reloadable feature node is required.");
    const byId = new Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>();
    for (const definition of definitions) {
      const id = normalizeNodeId(definition.id, "Feature node id");
      normalizeNodeId(definition.scope, `Feature node ${id} scope`);
      if (byId.has(id)) throw new Error(`Feature node ${id} is registered more than once.`);
      if (new Set(definition.dependencies).size !== definition.dependencies.length) throw new Error(`Feature node ${id} has duplicate dependencies.`);
      if (new Set(definition.featureKeys).size !== definition.featureKeys.length) throw new Error(`Feature node ${id} has duplicate feature keys.`);
      if (new Set(definition.requires).size !== definition.requires.length) throw new Error(`Feature node ${id} has duplicate required registrations.`);
      if (definition.safeAll && definition.access !== "agent") throw new Error(`Feature node ${id} cannot be included in safe all with ${definition.access} access.`);
      byId.set(id, definition);
    }
    for (const scope of this.requiredScopes) {
      if (!byId.has(scope)) throw new Error(`Reloadable topology is missing process-required scope ${scope}.`);
    }
    const providedKeys = new Map<keyof TFeatures, string>();
    for (const definition of byId.values()) {
      for (const key of definition.featureKeys) {
        const owner = providedKeys.get(key);
        if (owner) throw new Error(`Reloadable registration ${String(key)} is declared by both ${owner} and ${definition.id}.`);
        providedKeys.set(key, definition.id);
      }
    }
    for (const key of this.requiredRegistrations) {
      if (!providedKeys.has(key as keyof TFeatures)) throw new Error(`Reloadable topology is missing process-required registration ${String(key)}.`);
    }
    for (const definition of byId.values()) {
      for (const dependency of definition.dependencies) {
        if (!byId.has(dependency)) throw new Error(`Feature node ${definition.id} depends on unknown node ${dependency}.`);
        if (dependency === definition.id) throw new Error(`Feature node ${definition.id} cannot depend on itself.`);
      }
      const parentKeys = new Set(definition.dependencies.flatMap((dependency) => byId.get(dependency)!.featureKeys));
      for (const key of definition.requires) {
        if (!parentKeys.has(key)) throw new Error(`Feature node ${definition.id} requires ${String(key)} without a direct parent provider.`);
      }
    }
    const topology: OrchestratorReloadScope[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string, path: readonly string[]) => {
      if (visiting.has(nodeId)) throw new Error(`Feature graph cycle: ${[...path, nodeId].join(" -> ")}.`);
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      for (const dependency of byId.get(nodeId)!.dependencies) visit(dependency, [...path, nodeId]);
      visiting.delete(nodeId);
      visited.add(nodeId);
      topology.push(byId.get(nodeId)!.scope);
    };
    for (const nodeId of byId.keys()) visit(nodeId, []);
    return { definitions: byId, topology };
  }

  private hasTopologyChanged(
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    topology: readonly OrchestratorReloadScope[],
  ) {
    if (topology.length !== this.topology.length || topology.some((scope) => !this.definitions.has(scope))) return true;
    return topology.some((scope) => this.nodeTopologySignature(this.definitions.get(scope)!) !== this.nodeTopologySignature(definitions.get(scope)!));
  }

  private changedTopologyClosure(
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    scopes: readonly OrchestratorReloadScope[],
  ) {
    const selected = new Set<string>();
    const requested = new Set(scopes);
    for (const definition of [...this.definitions.values(), ...definitions.values()]) {
      if (requested.has(definition.scope)) selected.add(definition.scope);
    }
    for (const scope of new Set([...this.definitions.keys(), ...definitions.keys()])) {
      const previous = this.definitions.get(scope);
      const candidate = definitions.get(scope);
      if (!previous || !candidate || this.nodeTopologySignature(previous) !== this.nodeTopologySignature(candidate)) selected.add(scope);
    }
    const expand = (source: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>) => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const definition of source.values()) {
          if (!selected.has(definition.scope) && definition.dependencies.some((parent) => selected.has(parent))) {
            selected.add(definition.scope);
            changed = true;
          }
        }
      }
    };
    expand(this.definitions);
    expand(definitions);
    return selected;
  }

  private nodeTopologySignature(definition: OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>) {
    return [
      definition.scope,
      definition.lifecycle,
      definition.access,
      String(definition.safeAll),
      definition.dependencies.join("\0"),
      definition.featureKeys.map(String).join("\0"),
      definition.requires.map(String).join("\0"),
    ].join("\x01");
  }

  private selectDependants(
    scopes: readonly OrchestratorReloadScope[],
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
  ) {
    const requested = new Set(scopes);
    const selected = new Set<string>();
    for (const definition of definitions.values()) if (requested.delete(definition.scope)) selected.add(definition.id);
    const unknown = requested.values().next().value as string | undefined;
    if (unknown) throw new Error(`Unknown reloadable feature scope: ${unknown}.`);
    let changed = true;
    while (changed) {
      changed = false;
      for (const definition of definitions.values()) {
        if (!selected.has(definition.id) && definition.dependencies.some((dependency) => selected.has(dependency))) {
          selected.add(definition.id);
          changed = true;
        }
      }
    }
    return selected;
  }

  private validateFeatureOwnership(nodes: ReadonlyMap<string, ActiveNode<TContext, TFeatures, TNotification>>) {
    const owners = new Map<keyof TFeatures, string>();
    for (const [nodeId, node] of nodes) {
      for (const key of node.definition.featureKeys) {
        const owner = owners.get(key);
        if (owner) throw new Error(`Feature key ${String(key)} is owned by both ${owner} and ${nodeId}.`);
        owners.set(key, nodeId);
      }
    }
    return owners;
  }

  private dependencyClosure(nodeId: string, result = new Set<string>()) {
    if (result.has(nodeId)) return [...result];
    result.add(nodeId);
    for (const dependency of this.definitions.get(nodeId)?.dependencies ?? []) this.dependencyClosure(dependency, result);
    return [...result];
  }

  private requireNode(nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Feature node ${nodeId} is unavailable.`);
    return node;
  }

  private requireFeatureOwner(key: keyof TFeatures) {
    const owner = this.featureOwners.get(key);
    if (!owner) throw new Error(`Feature ${String(key)} has no registered owner.`);
    return owner;
  }

  private requireFeature<TKey extends keyof TFeatures>(
    nodes: ReadonlyMap<string, ActiveNode<TContext, TFeatures, TNotification>>,
    owners: ReadonlyMap<keyof TFeatures, string>,
    key: TKey,
  ) {
    const ownerId = owners.get(key);
    const value = ownerId ? nodes.get(ownerId)?.instance.registrations[key] : undefined;
    if (value === undefined) throw new Error(`Feature ${String(key)} is unavailable.`);
    return value as TFeatures[TKey];
  }

  private assertAcceptingWork() {
    if (this.hardShutdownStarted) throw new Error("The reloadable feature graph is hard shutting down; new work is unavailable.");
  }

  private isUnavailable(nodeId: string) {
    for (const rollback of this.pendingRollbacks) {
      if (rollback.nodes.some((node) => node.definition.id === nodeId)) return rollback.error;
    }
    return null;
  }

  private async waitForOpenDependencyChain(nodeId: string) {
    for (const dependencyId of this.dependencyClosure(nodeId)) {
      const failure = this.isUnavailable(dependencyId);
      if (failure) throw failure;
      const node = this.nodes.get(dependencyId);
      // The caller must resolve the current owner/chain again after a topology swap.
      if (!node) return;
      const gate = node.gate;
      if (gate) await gate;
      const currentFailure = this.isUnavailable(dependencyId);
      if (currentFailure) throw currentFailure;
    }
  }

  private closeGate(node: ActiveNode<TContext, TFeatures, TNotification>) {
    if (node.gate) return;
    node.gate = new Promise<void>((resolve) => { node.releaseGate = resolve; });
  }

  private openGate(node: ActiveNode<TContext, TFeatures, TNotification>) {
    node.releaseGate?.();
    node.gate = null;
    node.releaseGate = null;
  }

  private resolveDrain(node: ActiveNode<TContext, TFeatures, TNotification>) {
    if (node.activeOperations.size !== 0) return;
    for (const resolve of node.drainWaiters.splice(0)) resolve();
  }

  private beginDrain(node: ActiveNode<TContext, TFeatures, TNotification>) {
    if (node.runtimeDrainStartedAt !== null) return;
    node.runtimeDrainStartedAt = this.now();
    node.instance.beginRuntimeDrain?.();
  }

  private async waitForDrain(node: ActiveNode<TContext, TFeatures, TNotification>) {
    if (node.activeOperations.size === 0) return;
    await new Promise<void>((resolve) => node.drainWaiters.push(resolve));
  }

  private expireDrain(node: ActiveNode<TContext, TFeatures, TNotification>, handoff?: ReloadableNodeHandoff) {
    if (node.drainExpired) return;
    if (handoff) handoff.expire();
    else node.instance.expireRuntimeDrain?.();
    node.drainExpired = true;
  }

  private async retireNodes(
    nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[],
    handoffs: ReadonlyMap<string, ReloadableNodeHandoff>,
    transition: ReloadableNodeTransition,
  ) {
    for (const node of nodes) {
        node.startController.abort(new Error("Reloadable node was retired."));
        try { this.beginDrain(node); }
        catch (error) { this.reportLifecycleFailure(node.definition.id, "begin retirement", error); }
    }
    const expire = () => {
        for (const node of nodes) {
          try { this.expireDrain(node, handoffs.get(node.definition.id)); }
          catch (error) { this.reportLifecycleFailure(node.definition.id, "expire retirement", error); }
        }
    };
    try {
        await transition.drain("feature graph: drain", async () => {
          await Promise.all(nodes.map((node) => this.waitForDrain(node)));
        }, expire);
    } catch (error) {
        this.reportLifecycleFailure("feature graph", "retirement drain", error);
        expire();
    }
    const retirement: Retirement<TContext, TFeatures, TNotification> = { nodes, promise: Promise.resolve() };
    retirement.promise = (async () => {
      const errors: unknown[] = [];
      for (const node of nodes) {
        const id = node.definition.id;
        const handoff = handoffs.get(id);
        try {
          if (handoff) await handoff.commit();
          else await node.instance.dispose((phase) => {
              node.disposalPhase = boundedLabel(phase);
            });
        } catch (error) {
          this.reportLifecycleFailure(id, "retirement", error);
          errors.push(error);
        }
        finally { node.disposalPhase = null; }
      }
      if (errors.length) throw new AggregateError(errors, "Retired node cleanup failed.");
    })();
    this.retirements.add(retirement);
    void retirement.promise.then(
      () => { this.retirements.delete(retirement); },
      () => { /* Failed owners stay retained for terminal shutdown and diagnostics. */ },
    );
  }

  private async disposeNodes(nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[]) {
    const errors: unknown[] = [];
    for (const node of nodes) {
      node.startController.abort(new Error("Reloadable node was disposed."));
      node.disposalPhase = "feature node disposal";
      try {
        await node.instance.dispose((phase) => {
          node.disposalPhase = boundedLabel(phase);
        });
      } catch (error) {
        errors.push(error);
      } finally {
        node.disposalPhase = null;
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Multiple feature nodes failed to dispose.");
  }

  private async disposeNodesAfterFailure(
    nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[],
    failure: unknown,
    message: string,
  ): Promise<never> {
    try {
      await this.disposeNodes(nodes);
    } catch (disposeError) {
      throw new AggregateError([failure, disposeError], message);
    }
    throw failure;
  }

  private describeNodes(nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[], prefix: string) {
    const now = this.now();
    const pending: string[] = [];
    for (const node of nodes) {
      for (const { label, startedAt } of node.activeOperations.values()) pending.push(`${node.definition.id}: ${label} (${Math.max(0, now - startedAt)}ms)`);
      if (node.disposalPhase) pending.push(`${node.definition.id}: ${node.disposalPhase}`);
      for (const context of node.instance.listRuntimeDrainPending?.() ?? []) pending.push(`${node.definition.id}: ${boundedLabel(context.label)} (${Math.max(0, context.ageMs)}ms runtime context)`);
    }
    return `${prefix}. ${pending.length ? `Pending: ${pending.join(", ")}.` : "No additional pending-work details."}`;
  }
}
