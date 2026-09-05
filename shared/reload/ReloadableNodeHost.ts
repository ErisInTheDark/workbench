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
  private reloadTail = Promise.resolve();
  private transition: ReloadableNodeTransition | null = null;
  private readonly retirements = new Set<Retirement<TContext, TFeatures, TNotification>>();
  private readonly runtimeDrainTimeoutMs: number;
  private started = false;
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

  async start() {
    if (this.started) return;
    const started: ActiveNode<TContext, TFeatures, TNotification>[] = [];
    try {
      for (const nodeId of this.topology) {
        const node = this.requireNode(nodeId);
        await node.instance.start();
        started.push(node);
      }
      this.started = true;
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
      if (this.transition?.failure) {
        throw new Error(`A previous reload left an unsafe lifecycle; a process restart is required. ${this.transition.failure.message}`);
      }
      const transition = new ReloadableNodeTransition(
        this.createDeadline(this.runtimeDrainTimeoutMs),
        this.runtimeDrainTimeoutMs,
        () => this.describeNodes([
          ...this.nodes.values(),
          ...Array.from(this.retirements).flatMap((retirement) => retirement.nodes),
        ], "Pending reload work"),
        this.logError,
      );
      this.transition = transition;
      try {
        await transition.execute(async () => {
          const fresh = await transition.step("load graph", () => this.validateGraph(this.flattenGraph(this.loader.reload())));
          if (this.hasTopologyChanged(fresh.definitions, fresh.topology)) {
            if (!scopes.includes(this.topologyScope)) {
              throw new Error(`Reloadable node topology changed outside a ${this.topologyScope} reload. The current runtime was not changed.`);
            }
            for (const scope of this.changedTopologyClosure(fresh.definitions, scopes)) transition.affectedScopes.add(scope);
            await this.reloadChangedTopology(fresh.definitions, fresh.topology, scopes);
            return;
          }
          const selected = this.selectDependants(scopes, fresh.definitions);
          for (const scope of selected) transition.affectedScopes.add(scope);
          if (!selected.size) return;
          const ordered = fresh.topology.filter((nodeId) => selected.has(nodeId));
          if (ordered.some((nodeId) => fresh.definitions.get(nodeId)?.lifecycle === "handoff")) {
            await this.reloadWithHandoff(fresh.definitions, ordered);
          } else {
            await this.reloadAtomically(fresh.definitions, ordered);
          }
        });
      } catch (error) {
        if (transition.failure || !transition.liveGraphUsable) {
          transition.fail(error);
          if (transition.liveGraphUsable) {
            for (const scope of transition.affectedScopes) {
              const node = this.nodes.get(scope);
              if (node) this.openGate(node);
            }
          }
          for (const retirement of this.retirements) {
            for (const node of retirement.nodes) node.instance.expireRuntimeDrain?.();
          }
          this.logError(transition.failure!.message.slice(0, 2_000));
        }
        throw error;
      } finally {
        transition.finish();
        if (!transition.failure) this.transition = null;
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

  async dispose() {
    await this.reloadTail;
    this.transition?.assertActive();
    const nodes = [...this.topology].reverse().map((nodeId) => this.requireNode(nodeId));
    for (const node of nodes) this.beginDrain(node);
    await Promise.all(nodes.map(async (node) => await this.waitForDrain(node)));
    await this.disposeNodes(nodes);
  }

  beginHardShutdown() {
    if (this.hardShutdownPromise) return this.hardShutdownPromise;
    this.hardShutdownStarted = true;
    this.hardShutdownPromise = (async () => {
      const blocking = new Set([
        ...this.nodes.values(),
        ...Array.from(this.retirements).flatMap((retirement) => retirement.nodes),
      ]);
      for (const node of blocking) {
        this.beginDrain(node);
        node.instance.expireRuntimeDrain?.();
      }

      await this.reloadTail;
      this.transition?.assertActive();

      const nodes = [...this.topology].reverse().map((nodeId) => this.requireNode(nodeId));
      const retirements = Array.from(this.retirements);
      const finalDraining = new Set([
        ...nodes,
        ...retirements.flatMap((retirement) => retirement.nodes),
      ]);
      for (const node of finalDraining) {
        this.beginDrain(node);
        node.instance.expireRuntimeDrain?.();
      }
      await Promise.all([
        ...retirements.map((retirement) => retirement.promise),
        Promise.all(nodes.map(async (node) => await this.waitForDrain(node))).then(async () => await this.disposeNodes(nodes)),
      ]);
    })();
    return this.hardShutdownPromise;
  }

  private async reloadAtomically(
    definitions: Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    ordered: readonly string[],
  ) {
    const selected = new Set(ordered);
    const candidates = this.createNodes(definitions, ordered, this.nodes, new Map(), selected, "replacement");
    try {
      if (this.started) {
        for (const nodeId of ordered) {
          this.assertAcceptingWork();
          await this.lifecycle(nodeId, "start", () => candidates.get(nodeId)!.instance.start());
        }
      }
      this.assertAcceptingWork();
    } catch (error) {
      this.transition?.assertActive();
      await this.disposeNodesAfterFailure([...candidates.values()].reverse(), error, "Atomic feature replacement startup and cleanup both failed.");
    }
    const previous = ordered.map((nodeId) => this.requireNode(nodeId));
    this.transition!.liveGraphUsable = false;
    for (const nodeId of ordered) this.nodes.set(nodeId, candidates.get(nodeId)!);
    this.definitions = definitions;
    this.featureOwners = this.validateFeatureOwnership(this.nodes);
    let activationError: unknown = null;
    try {
      for (const nodeId of ordered) await this.lifecycle(nodeId, "activate", () => candidates.get(nodeId)!.instance.activate?.());
      this.transition!.liveGraphUsable = true;
      await this.lifecycle("feature graph", "publish notification", () => this.onSwap(ordered));
    } catch (error) {
      this.transition?.assertActive();
      activationError = error;
    }
    await this.retireNodes([...previous].reverse());
    if (activationError) throw activationError;
  }

  private async reloadWithHandoff(
    definitions: Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    ordered: readonly string[],
  ) {
    const selected = new Set(ordered);
    const handoffIds = ordered.filter((nodeId) => definitions.get(nodeId)?.lifecycle === "handoff");
    const atomicIds = ordered.filter((nodeId) => (
      definitions.get(nodeId)?.lifecycle === "atomic"
      && !this.hasSelectedHandoffDependency(nodeId, selected, definitions)
    ));
    const delayedIds = ordered.filter((nodeId) => !atomicIds.includes(nodeId));
    const candidates = this.createNodes(definitions, atomicIds, this.nodes, new Map(), selected, "replacement");
    try {
      if (this.started) {
        for (const nodeId of atomicIds) {
          this.assertAcceptingWork();
          await this.lifecycle(nodeId, "start", () => candidates.get(nodeId)!.instance.start());
        }
      }
      this.assertAcceptingWork();
    } catch (error) {
      this.transition?.assertActive();
      await this.disposeNodesAfterFailure([...candidates.values()].reverse(), error, "Handoff feature replacement startup and cleanup both failed.");
    }

    const previous = ordered.map((nodeId) => this.requireNode(nodeId));
    for (const node of previous) this.closeGate(node);
    try {
      await this.waitForNodesDrain(previous);
      this.assertAcceptingWork();
    } catch (error) {
      this.transition?.assertActive();
      for (const node of previous) this.openGate(node);
      await this.disposeNodesAfterFailure([...candidates.values()].reverse(), error, "Handoff feature drain and candidate cleanup both failed.");
    }

    const handoffStates = new Map<string, unknown>();
    const detachedHandoffIds: string[] = [];
    let committed = false;
    try {
      for (const nodeId of [...handoffIds].reverse()) {
        const node = this.requireNode(nodeId);
        if (!node.instance.detachForReload) throw new Error(`Handoff feature node ${nodeId} does not implement detachForReload.`);
        this.transition!.liveGraphUsable = false;
        handoffStates.set(nodeId, await this.lifecycle(nodeId, "detach", () => node.instance.detachForReload!({ isReplacing: (candidateId) => selected.has(candidateId) })));
        detachedHandoffIds.push(nodeId);
        this.assertAcceptingWork();
      }
      const built = this.createNodes(definitions, delayedIds, new Map([...this.nodes, ...candidates]), handoffStates, selected, "replacement");
      for (const [nodeId, node] of built) candidates.set(nodeId, node);
      if (this.started) {
        for (const nodeId of delayedIds) {
          this.assertAcceptingWork();
          await this.lifecycle(nodeId, "start", () => candidates.get(nodeId)!.instance.start());
        }
      }
      this.assertAcceptingWork();
      for (const nodeId of ordered) this.nodes.set(nodeId, candidates.get(nodeId)!);
      this.definitions = definitions;
      this.featureOwners = this.validateFeatureOwnership(this.nodes);
      for (const node of previous) this.openGate(node);
      committed = true;
      let activationError: unknown = null;
      try {
        for (const nodeId of ordered) await this.lifecycle(nodeId, "activate", () => candidates.get(nodeId)!.instance.activate?.());
        this.transition!.liveGraphUsable = true;
        await this.lifecycle("feature graph", "publish notification", () => this.onSwap(ordered));
      } catch (error) {
        this.transition?.assertActive();
        activationError = error;
      }
      await this.retireNodes([...previous].reverse());
      if (activationError) throw activationError;
    } catch (error) {
      this.transition?.assertActive();
      if (committed) throw error;
      const rollbackErrors: unknown[] = [];
      try {
        await this.disposeNodes([...candidates.values()].reverse());
      } catch (disposeError) {
        this.transition?.assertActive();
        rollbackErrors.push(disposeError);
      }
      if (detachedHandoffIds.length) {
        try {
          await this.restoreHandoffNodes(detachedHandoffIds, handoffStates);
        } catch (restoreError) {
          this.transition?.assertActive();
          rollbackErrors.push(restoreError);
        }
      }
      for (const node of previous) this.openGate(node);
      if (rollbackErrors.length) {
        for (const rollbackError of rollbackErrors) {
          this.logError(`Feature graph rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
        throw new AggregateError([error, ...rollbackErrors], "Feature graph replacement and rollback both failed.");
      }
      this.transition!.liveGraphUsable = true;
      throw error;
    }
  }

  private async restoreHandoffNodes(handoffIds: readonly string[], states: ReadonlyMap<string, unknown>) {
    const restored = new Map<string, ActiveNode<TContext, TFeatures, TNotification>>();
    const dependencies = new Map(this.nodes);
    try {
      for (const nodeId of this.topology.filter((candidate) => handoffIds.includes(candidate))) {
        const built = this.createNodes(this.definitions, [nodeId], new Map([...dependencies, ...restored]), new Map([[nodeId, states.get(nodeId)]]), new Set(handoffIds), "restore");
        const node = built.get(nodeId)!;
        restored.set(nodeId, node);
        if (this.started) await this.lifecycle(nodeId, "restore start", () => node.instance.start());
      }
    } catch (error) {
      this.transition?.assertActive();
      await this.disposeNodesAfterFailure([...restored.values()].reverse(), error, "Feature graph restore startup and cleanup both failed.");
    }
    for (const [nodeId, node] of restored) this.nodes.set(nodeId, node);
    this.featureOwners = this.validateFeatureOwnership(this.nodes);
    for (const nodeId of this.topology.filter((candidate) => restored.has(candidate))) {
      await this.lifecycle(nodeId, "restore activate", () => restored.get(nodeId)!.instance.activate?.());
    }
  }

  private async reloadChangedTopology(
    definitions: Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    topology: readonly OrchestratorReloadScope[],
    scopes: readonly OrchestratorReloadScope[],
  ) {
    const previousDefinitions = this.definitions;
    const previousTopology = this.topology;
    const selected = this.changedTopologyClosure(definitions, scopes);
    const previousIds = previousTopology.filter((scope) => selected.has(scope));
    const candidateIds = topology.filter((scope) => selected.has(scope));
    const previous = previousIds.map((scope) => this.requireNode(scope));
    for (const node of previous) this.closeGate(node);
    try {
      await this.waitForNodesDrain(previous);
      this.assertAcceptingWork();
    } catch (error) {
      this.transition?.assertActive();
      for (const node of previous) this.openGate(node);
      throw error;
    }

    const handoffStates = new Map<string, unknown>();
    const detachedPreviousHandoffIds: string[] = [];
    let candidates = new Map<string, ActiveNode<TContext, TFeatures, TNotification>>();
    let candidatesPublished = false;
    let activated = false;
    try {
      for (const scope of [...previousIds].reverse()) {
        const node = this.requireNode(scope);
        if (node.definition.lifecycle === "handoff") {
          if (!node.instance.detachForReload) throw new Error(`Handoff reloadable node ${scope} does not implement detachForReload.`);
          this.transition!.liveGraphUsable = false;
          handoffStates.set(scope, await this.lifecycle(scope, "detach", () => node.instance.detachForReload!({ isReplacing: (candidate) => selected.has(candidate) })));
          detachedPreviousHandoffIds.push(scope);
        }
      }

      const retained = new Map(this.nodes);
      for (const scope of previousIds) retained.delete(scope);
      candidates = this.createNodes(definitions, candidateIds, retained, handoffStates, selected, "replacement");
      this.publishGraph(new Map([...retained, ...candidates]), definitions, topology, candidateIds);
      candidatesPublished = true;
      await this.startPublishedNodes(candidates, candidateIds);
      for (const scope of candidateIds) await this.lifecycle(scope, "activate", () => candidates.get(scope)!.instance.activate?.());
      this.transition!.liveGraphUsable = true;
      activated = true;
      for (const node of previous) this.openGate(node);
      await this.lifecycle("feature graph", "publish notification", () => this.onSwap(candidateIds));
    } catch (error) {
      this.transition?.assertActive();
      if (activated) throw error;
      const rollbackErrors: unknown[] = [];

      if (!candidatesPublished) {
        try {
          await this.detachHandoffNodes(candidates, candidateIds, definitions, selected, handoffStates);
          await this.disposeNodes([...candidates.values()].reverse());
          if (detachedPreviousHandoffIds.length) await this.restoreHandoffNodes(detachedPreviousHandoffIds, handoffStates);
        } catch (restoreError) {
          this.transition?.assertActive();
          rollbackErrors.push(restoreError);
        }
        for (const node of previous) this.openGate(node);
      } else {
        const candidateNodes = [...candidates.values()];
        for (const node of candidateNodes) this.closeGate(node);
        try {
          await this.waitForNodesDrain(candidateNodes);
          for (const node of candidateNodes) if (node.definition.lifecycle === "atomic") this.beginDrain(node);
          await this.detachHandoffNodes(candidates, candidateIds, definitions, selected, handoffStates);

          const retained = new Map(this.nodes);
          for (const scope of new Set([...previousIds, ...candidateIds])) retained.delete(scope);
          const restored = this.createNodes(previousDefinitions, previousIds, retained, handoffStates, selected, "restore");
          this.publishGraph(new Map([...retained, ...restored]), previousDefinitions, previousTopology, previousIds);
          await this.startPublishedNodes(restored, previousIds);
          for (const scope of previousIds) await this.lifecycle(scope, "restore activate", () => restored.get(scope)!.instance.activate?.());
          this.transition!.liveGraphUsable = true;
          for (const node of candidateNodes) this.openGate(node);
          for (const node of previous) this.openGate(node);
          await this.retireNodes([...candidateNodes].reverse());
          await this.retireNodes([...previous].reverse());
        } catch (restoreError) {
          this.transition?.assertActive();
          rollbackErrors.push(restoreError);
        }
      }

      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], "Reloadable topology replacement and rollback both failed.");
      }
      this.transition!.liveGraphUsable = true;
      throw error;
    }
    await this.retireNodes([...previous].reverse());
  }

  private publishGraph(
    nodes: Map<string, ActiveNode<TContext, TFeatures, TNotification>>,
    definitions: Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    topology: readonly OrchestratorReloadScope[],
    gatedIds: readonly string[],
  ) {
    const featureOwners = this.validateFeatureOwnership(nodes);
    this.transition!.liveGraphUsable = false;
    for (const nodeId of gatedIds) this.closeGate(nodes.get(nodeId)!);
    this.nodes = nodes;
    this.definitions = definitions;
    this.topology = topology;
    this.featureOwners = featureOwners;
  }

  private async startPublishedNodes(
    nodes: ReadonlyMap<string, ActiveNode<TContext, TFeatures, TNotification>>,
    ordered: readonly string[],
  ) {
    for (const nodeId of ordered) {
      const node = nodes.get(nodeId)!;
      if (this.started) await this.lifecycle(nodeId, "start", () => node.instance.start());
      this.openGate(node);
    }
  }

  private async detachHandoffNodes(
    nodes: ReadonlyMap<string, ActiveNode<TContext, TFeatures, TNotification>>,
    ordered: readonly string[],
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    selected: ReadonlySet<string>,
    handoffStates: Map<string, unknown>,
  ) {
    for (const nodeId of [...ordered].reverse()) {
      if (definitions.get(nodeId)?.lifecycle !== "handoff") continue;
      const node = nodes.get(nodeId);
      if (!node) continue;
      if (!node.instance.detachForReload) throw new Error(`Handoff reloadable node ${nodeId} does not implement detachForReload.`);
      handoffStates.set(nodeId, await this.lifecycle(nodeId, "detach", () => node.instance.detachForReload!({ isReplacing: (candidate) => selected.has(candidate) })));
    }
  }

  private createNodes(
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    ordered: readonly string[],
    dependencies: ReadonlyMap<string, ActiveNode<TContext, TFeatures, TNotification>>,
    handoffStates: ReadonlyMap<string, unknown>,
    selected: ReadonlySet<string>,
    mode: ReloadableNodeBuild<TFeatures>["mode"],
  ) {
    const created = new Map<string, ActiveNode<TContext, TFeatures, TNotification>>();
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
      const actualKeys = Object.keys(instance.registrations) as (keyof TFeatures)[];
      if (actualKeys.length !== definition.featureKeys.length || actualKeys.some((key) => !definition.featureKeys.includes(key))) {
        throw new Error(`Feature node ${nodeId} did not create exactly its declared feature keys.`);
      }
      created.set(nodeId, {
        activeOperations: new Map(), definition, disposalPhase: null, drainWaiters: [], gate: null,
        instance, releaseGate: null, runtimeDrainStartedAt: null, token,
      });
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

  private hasSelectedHandoffDependency(
    nodeId: string,
    selected: ReadonlySet<string>,
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    visited = new Set<string>(),
  ): boolean {
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    for (const dependency of definitions.get(nodeId)?.dependencies ?? []) {
      if (!selected.has(dependency)) continue;
      if (definitions.get(dependency)?.lifecycle === "handoff" || this.hasSelectedHandoffDependency(dependency, selected, definitions, visited)) return true;
    }
    return false;
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
    return this.transition?.failure && !this.transition.liveGraphUsable
      && this.transition.affectedScopes.has(nodeId);
  }

  private async lifecycle<T>(nodeId: string, phase: string, operation: () => Promise<T> | T) {
    return this.transition
      ? await this.transition.step(`${nodeId}: ${phase}`, operation)
      : await operation();
  }

  private async waitForOpenDependencyChain(nodeId: string) {
    for (const dependencyId of this.dependencyClosure(nodeId)) {
      if (this.isUnavailable(dependencyId)) throw this.transition!.failure;
      const node = this.nodes.get(dependencyId);
      // The caller must resolve the current owner/chain again after a topology swap.
      if (!node) return;
      const gate = node.gate;
      if (gate) {
        if (this.transition) await this.transition.waitFor(gate);
        else await gate;
      }
      if (this.isUnavailable(dependencyId)) throw this.transition!.failure;
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

  private async waitForNodesDrain(nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[]) {
    await this.lifecycle("feature graph", "drain", () => Promise.all(nodes.map((node) => this.waitForDrain(node))));
  }

  private async retireNodes(nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[]) {
    for (const node of nodes) this.beginDrain(node);
    const retirement: Retirement<TContext, TFeatures, TNotification> = { nodes, promise: Promise.resolve() };
    const transition = this.transition;
    retirement.promise = this.waitForNodesDrain(nodes).then(async () => await this.disposeNodes(nodes));
    this.retirements.add(retirement);
    void retirement.promise.then(
      () => { this.retirements.delete(retirement); },
      (error: unknown) => {
        this.retirements.delete(retirement);
        if (transition?.failure && error !== transition.failure) this.logError("A stopped reload's retired node later failed to dispose.");
      },
    );
    try {
      await retirement.promise;
    } catch (error) {
      transition?.fail(error);
      throw error;
    }
  }

  private async disposeNodes(nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[]) {
    const errors: unknown[] = [];
    for (const node of nodes) {
      node.disposalPhase = "feature node disposal";
      try {
        await this.lifecycle(node.definition.id, "dispose", () => node.instance.dispose((phase) => {
          node.disposalPhase = boundedLabel(phase);
        }));
      } catch (error) {
        this.transition?.assertActive();
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
    this.transition?.assertActive();
    try {
      await this.disposeNodes(nodes);
    } catch (disposeError) {
      this.transition?.assertActive();
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
    return `${prefix}. Pending: ${pending.length ? pending.join(", ") : "retirement completion did not settle"}.`;
  }
}
