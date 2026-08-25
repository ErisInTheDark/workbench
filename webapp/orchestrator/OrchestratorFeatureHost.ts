/*
 * Exports:
 * - OrchestratorFeatureLease: node token that fences late outward effects after replacement. Keywords: reload, node, generation, fence.
 * - OrchestratorFeatureRuntimeDrainPending: bounded node drain diagnostics. Keywords: reload, drain, diagnostics.
 * - OrchestratorFeatureNodeLifecycle: atomic or handoff replacement mode. Keywords: graph, lifecycle, mode.
 * - OrchestratorFeatureNodeInstance: one active node value and lifecycle surface. Keywords: graph, runtime, value.
 * - OrchestratorFeatureNodeBuild: dependency lookup, handoff state, replacement set, lease, and construction mode. Keywords: factory, dependency, rollback.
 * - OrchestratorFeatureNodeDefinition: node id, scope, parents, owned keys, lifecycle, and factory. Keywords: graph, scope, ownership.
 * - OrchestratorFeatureModule/OrchestratorFeatureModuleLoader: reloadable graph registry and fresh-module loader contracts. Keywords: registry, module, loader.
 * - OrchestratorFeatureHostOptions: deadline, clock, logging, and swap ports owned by the process host. Keywords: host, deadline, ports.
 * - default OrchestratorFeatureHost: validate topology, lease dependency chains, and replace scope-selected dependant closures. Keywords: graph, atomic, handoff, rollback.
 */
export interface OrchestratorFeatureLease {
  isCurrent(): boolean;
}

export interface OrchestratorFeatureRuntimeDrainPending {
  ageMs: number;
  label: string;
}

export type OrchestratorFeatureNodeLifecycle = "atomic" | "handoff";

export interface OrchestratorFeatureNodeInstance<TFeatures extends object, TNotification> {
  activate?(): Promise<void> | void;
  beginRuntimeDrain?(): void;
  detachForReload?(replacement: { isReplacing(nodeId: string): boolean }): Promise<unknown> | unknown;
  dispose(reportPhase?: (phase: string) => void): Promise<void> | void;
  expireRuntimeDrain?(): void;
  features: Partial<TFeatures>;
  listRuntimeDrainPending?(): readonly OrchestratorFeatureRuntimeDrainPending[];
  observeProviderNotification?(notification: TNotification): Promise<void> | void;
  start(): Promise<void> | void;
}

export interface OrchestratorFeatureNodeBuild<TFeatures extends object> {
  get<TKey extends keyof TFeatures>(key: TKey): TFeatures[TKey];
  handoffState: unknown;
  isReplacing(nodeId: string): boolean;
  lease: OrchestratorFeatureLease;
  mode: "initial" | "replacement" | "restore";
}

export interface OrchestratorFeatureNodeDefinition<TContext, TFeatures extends object, TNotification> {
  create(context: TContext, build: OrchestratorFeatureNodeBuild<TFeatures>): OrchestratorFeatureNodeInstance<TFeatures, TNotification>;
  dependencies: readonly string[];
  featureKeys: readonly (keyof TFeatures)[];
  id: string;
  lifecycle: OrchestratorFeatureNodeLifecycle;
  scope: string;
}

export interface OrchestratorFeatureModule<TContext, TFeatures extends object, TNotification> {
  createOrchestratorFeatureNodes(context: TContext): readonly OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>[];
}

export interface OrchestratorFeatureModuleLoader<TContext, TFeatures extends object, TNotification> {
  load(): OrchestratorFeatureModule<TContext, TFeatures, TNotification>;
  reload(): OrchestratorFeatureModule<TContext, TFeatures, TNotification>;
}

interface RuntimeDrainDeadline {
  cancel(): void;
  expired: Promise<void>;
}

export interface OrchestratorFeatureHostOptions {
  createRuntimeDrainDeadline?: (timeoutMs: number) => RuntimeDrainDeadline;
  logError?: (message: string) => void;
  now?: () => number;
  onSwap?: (nodeIds: readonly string[]) => Promise<void> | void;
  runtimeDrainTimeoutMs?: number;
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
  instance: OrchestratorFeatureNodeInstance<TFeatures, TNotification>;
  releaseGate: (() => void) | null;
  runtimeDrainStartedAt: number | null;
  token: symbol;
}

interface Retirement<TContext, TFeatures extends object, TNotification> {
  nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[];
  promise: Promise<void>;
  settled: boolean;
  timedOut: boolean;
}

const DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS = 30_000;

function boundedLabel(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim() || "unnamed operation";
  return normalized.length > 200 ? `${normalized.slice(0, 197).trimEnd()}...` : normalized;
}

function createRuntimeDrainDeadline(timeoutMs: number): RuntimeDrainDeadline {
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

export default class OrchestratorFeatureHost<TContext, TFeatures extends object, TNotification> {
  private readonly createDeadline: NonNullable<OrchestratorFeatureHostOptions["createRuntimeDrainDeadline"]>;
  private definitions = new Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>();
  private featureOwners = new Map<keyof TFeatures, string>();
  private hardShutdownStarted = false;
  private hardShutdownPromise: Promise<void> | null = null;
  private readonly logError: NonNullable<OrchestratorFeatureHostOptions["logError"]>;
  private readonly now: NonNullable<OrchestratorFeatureHostOptions["now"]>;
  private readonly onSwap: NonNullable<OrchestratorFeatureHostOptions["onSwap"]>;
  private nodes = new Map<string, ActiveNode<TContext, TFeatures, TNotification>>();
  private reloadTail = Promise.resolve();
  private readonly retirements = new Set<Retirement<TContext, TFeatures, TNotification>>();
  private readonly runtimeDrainTimeoutMs: number;
  private started = false;
  private topology: readonly string[] = [];

  constructor(
    private readonly context: TContext,
    private readonly loader: OrchestratorFeatureModuleLoader<TContext, TFeatures, TNotification>,
    options: OrchestratorFeatureHostOptions = {},
  ) {
    this.createDeadline = options.createRuntimeDrainDeadline ?? createRuntimeDrainDeadline;
    this.logError = options.logError ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.onSwap = options.onSwap ?? (() => undefined);
    this.runtimeDrainTimeoutMs = options.runtimeDrainTimeoutMs ?? DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS;
    const graph = this.validateGraph(loader.load().createOrchestratorFeatureNodes(context));
    this.definitions = graph.definitions;
    this.topology = graph.topology;
    this.nodes = this.createNodes(graph.definitions, graph.topology, new Map(), new Map(), new Set(), "initial");
    this.featureOwners = this.validateFeatureOwnership(this.nodes);
  }

  get<TKey extends keyof TFeatures>(key: TKey) {
    return this.requireFeature(this.nodes, this.featureOwners, key);
  }

  async run<TKey extends keyof TFeatures, TResult>(
    key: TKey,
    operation: (feature: TFeatures[TKey]) => Promise<TResult> | TResult,
    label = String(key),
  ) {
    this.assertAcceptingWork();
    const ownerId = this.requireFeatureOwner(key);
    await this.waitForOpenDependencyChain(ownerId);
    this.assertAcceptingWork();
    const leased = this.dependencyClosure(ownerId).map((nodeId) => this.requireNode(nodeId));
    const token = Symbol("orchestrator-feature-operation");
    const activeOperation = { label: boundedLabel(label), startedAt: this.now() };
    for (const node of leased) node.activeOperations.set(token, activeOperation);
    try {
      const owner = this.requireNode(ownerId);
      return await operation(owner.instance.features[key] as TFeatures[TKey]);
    } finally {
      for (const node of leased) {
        node.activeOperations.delete(token);
        this.resolveDrain(node);
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

  validateReloadScopes(scopes: readonly string[]) {
    this.selectDependants(scopes, this.definitions);
  }

  async reload(scopes: readonly string[]) {
    this.assertAcceptingWork();
    const operation = this.reloadTail.then(async () => {
      this.assertAcceptingWork();
      const blocked = Array.from(this.retirements).find((retirement) => retirement.timedOut && !retirement.settled);
      if (blocked) throw new Error(this.describeTimedOutRetirement(blocked, "A previous feature node retirement still has timed-out runtime work"));
      const fresh = this.validateGraph(this.loader.reload().createOrchestratorFeatureNodes(this.context));
      this.assertStableTopology(fresh.definitions, fresh.topology);
      const selected = this.selectDependants(scopes, fresh.definitions);
      if (!selected.size) return;
      const ordered = fresh.topology.filter((nodeId) => selected.has(nodeId));
      if (ordered.some((nodeId) => fresh.definitions.get(nodeId)?.lifecycle === "handoff")) {
        await this.reloadWithHandoff(fresh.definitions, ordered);
      } else {
        await this.reloadAtomically(fresh.definitions, ordered);
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
      const token = Symbol("orchestrator-provider-notification");
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
          await candidates.get(nodeId)!.instance.start();
        }
      }
      this.assertAcceptingWork();
    } catch (error) {
      await this.disposeNodesAfterFailure([...candidates.values()].reverse(), error, "Atomic feature replacement startup and cleanup both failed.");
    }
    const previous = ordered.map((nodeId) => this.requireNode(nodeId));
    for (const nodeId of ordered) this.nodes.set(nodeId, candidates.get(nodeId)!);
    this.definitions = definitions;
    this.featureOwners = this.validateFeatureOwnership(this.nodes);
    let activationError: unknown = null;
    try {
      for (const nodeId of ordered) await candidates.get(nodeId)!.instance.activate?.();
      await this.onSwap(ordered);
    } catch (error) {
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
          await candidates.get(nodeId)!.instance.start();
        }
      }
      this.assertAcceptingWork();
    } catch (error) {
      await this.disposeNodesAfterFailure([...candidates.values()].reverse(), error, "Handoff feature replacement startup and cleanup both failed.");
    }

    const previous = ordered.map((nodeId) => this.requireNode(nodeId));
    for (const node of previous) this.closeGate(node);
    try {
      await this.waitForNodesDrain(previous);
      this.assertAcceptingWork();
    } catch (error) {
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
        handoffStates.set(nodeId, await node.instance.detachForReload({ isReplacing: (candidateId) => selected.has(candidateId) }));
        detachedHandoffIds.push(nodeId);
        this.assertAcceptingWork();
      }
      const built = this.createNodes(definitions, delayedIds, new Map([...this.nodes, ...candidates]), handoffStates, selected, "replacement");
      for (const [nodeId, node] of built) candidates.set(nodeId, node);
      if (this.started) {
        for (const nodeId of delayedIds) {
          this.assertAcceptingWork();
          await candidates.get(nodeId)!.instance.start();
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
        for (const nodeId of ordered) await candidates.get(nodeId)!.instance.activate?.();
        await this.onSwap(ordered);
      } catch (error) {
        activationError = error;
      }
      for (const node of previous) if (node.definition.lifecycle === "atomic") this.beginDrain(node);
      await this.disposeNodes([...previous].reverse());
      if (activationError) throw activationError;
    } catch (error) {
      if (committed) throw error;
      const rollbackErrors: unknown[] = [];
      try {
        await this.disposeNodes([...candidates.values()].reverse());
      } catch (disposeError) {
        rollbackErrors.push(disposeError);
      }
      if (detachedHandoffIds.length) {
        try {
          await this.restoreHandoffNodes(detachedHandoffIds, handoffStates);
        } catch (restoreError) {
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
        if (this.started) await node.instance.start();
      }
    } catch (error) {
      await this.disposeNodesAfterFailure([...restored.values()].reverse(), error, "Feature graph restore startup and cleanup both failed.");
    }
    for (const [nodeId, node] of restored) this.nodes.set(nodeId, node);
    this.featureOwners = this.validateFeatureOwnership(this.nodes);
    for (const nodeId of this.topology.filter((candidate) => restored.has(candidate))) {
      await restored.get(nodeId)!.instance.activate?.();
    }
  }

  private createNodes(
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    ordered: readonly string[],
    dependencies: ReadonlyMap<string, ActiveNode<TContext, TFeatures, TNotification>>,
    handoffStates: ReadonlyMap<string, unknown>,
    selected: ReadonlySet<string>,
    mode: OrchestratorFeatureNodeBuild<TFeatures>["mode"],
  ) {
    const created = new Map<string, ActiveNode<TContext, TFeatures, TNotification>>();
    for (const nodeId of ordered) {
      const definition = definitions.get(nodeId)!;
      const token = Symbol(`orchestrator-feature-node:${nodeId}`);
      const visible = new Map([...dependencies, ...created]);
      const instance = definition.create(this.context, {
        get: <TKey extends keyof TFeatures>(key: TKey) => this.requireFeature(visible, this.validateFeatureOwnership(visible), key),
        handoffState: handoffStates.get(nodeId),
        isReplacing: (candidateId) => selected.has(candidateId),
        lease: { isCurrent: () => !this.hardShutdownStarted && this.nodes.get(nodeId)?.token === token },
        mode,
      });
      const actualKeys = Object.keys(instance.features) as (keyof TFeatures)[];
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

  private validateGraph(definitions: readonly OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>[]) {
    if (!definitions.length) throw new Error("At least one orchestrator feature node is required.");
    const byId = new Map<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>();
    for (const definition of definitions) {
      const id = normalizeNodeId(definition.id, "Feature node id");
      normalizeNodeId(definition.scope, `Feature node ${id} scope`);
      if (byId.has(id)) throw new Error(`Feature node ${id} is registered more than once.`);
      if (new Set(definition.dependencies).size !== definition.dependencies.length) throw new Error(`Feature node ${id} has duplicate dependencies.`);
      if (new Set(definition.featureKeys).size !== definition.featureKeys.length) throw new Error(`Feature node ${id} has duplicate feature keys.`);
      byId.set(id, definition);
    }
    for (const definition of byId.values()) {
      for (const dependency of definition.dependencies) {
        if (!byId.has(dependency)) throw new Error(`Feature node ${definition.id} depends on unknown node ${dependency}.`);
        if (dependency === definition.id) throw new Error(`Feature node ${definition.id} cannot depend on itself.`);
      }
    }
    const topology: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string, path: readonly string[]) => {
      if (visiting.has(nodeId)) throw new Error(`Feature graph cycle: ${[...path, nodeId].join(" -> ")}.`);
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      for (const dependency of byId.get(nodeId)!.dependencies) visit(dependency, [...path, nodeId]);
      visiting.delete(nodeId);
      visited.add(nodeId);
      topology.push(nodeId);
    };
    for (const nodeId of byId.keys()) visit(nodeId, []);
    return { definitions: byId, topology };
  }

  private assertStableTopology(
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
    topology: readonly string[],
  ) {
    if (topology.length !== this.topology.length || topology.some((nodeId) => !this.definitions.has(nodeId))) {
      throw new Error("Feature graph topology changed during a live reload. Restart the orchestrator to adopt node additions or removals.");
    }
    for (const nodeId of topology) {
      const previous = this.definitions.get(nodeId)!;
      const next = definitions.get(nodeId)!;
      if (
        previous.scope !== next.scope
        || previous.lifecycle !== next.lifecycle
        || previous.dependencies.join("\0") !== next.dependencies.join("\0")
        || previous.featureKeys.map(String).join("\0") !== next.featureKeys.map(String).join("\0")
      ) {
        throw new Error(`Feature node ${nodeId} changed scope, dependencies, owned keys, or lifecycle during a live reload. Restart the orchestrator to adopt topology changes.`);
      }
    }
  }

  private selectDependants(
    scopes: readonly string[],
    definitions: ReadonlyMap<string, OrchestratorFeatureNodeDefinition<TContext, TFeatures, TNotification>>,
  ) {
    const requested = new Set(scopes);
    const selected = new Set<string>();
    for (const definition of definitions.values()) if (requested.delete(definition.scope)) selected.add(definition.id);
    const unknown = requested.values().next().value as string | undefined;
    if (unknown) throw new Error(`Unknown orchestrator feature reload scope: ${unknown}.`);
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
    const value = ownerId ? nodes.get(ownerId)?.instance.features[key] : undefined;
    if (value === undefined) throw new Error(`Feature ${String(key)} is unavailable.`);
    return value as TFeatures[TKey];
  }

  private assertAcceptingWork() {
    if (this.hardShutdownStarted) throw new Error("The orchestrator feature graph is hard shutting down; new work is unavailable.");
  }

  private async waitForOpenDependencyChain(nodeId: string) {
    for (const dependencyId of this.dependencyClosure(nodeId)) {
      const gate = this.requireNode(dependencyId).gate;
      if (gate) await gate;
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
    const deadline = this.createDeadline(this.runtimeDrainTimeoutMs);
    const waiting = Promise.all(nodes.map(async (node) => await this.waitForDrain(node)));
    const outcome = await Promise.race([waiting.then(() => "settled" as const), deadline.expired.then(() => "deadline" as const)]);
    if (outcome === "settled") {
      deadline.cancel();
      return;
    }
    for (const node of nodes) node.instance.expireRuntimeDrain?.();
    throw new Error(this.describeNodes(nodes, `Feature handoff drain exceeded ${this.runtimeDrainTimeoutMs}ms`));
  }

  private async retireNodes(nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[]) {
    for (const node of nodes) this.beginDrain(node);
    const retirement = { nodes, promise: Promise.resolve(), settled: false, timedOut: false } as Retirement<TContext, TFeatures, TNotification>;
    retirement.promise = Promise.all(nodes.map(async (node) => await this.waitForDrain(node))).then(async () => await this.disposeNodes(nodes));
    this.retirements.add(retirement);
    void retirement.promise.then(
      () => { retirement.settled = true; this.retirements.delete(retirement); },
      (error: unknown) => {
        retirement.settled = true;
        this.retirements.delete(retirement);
        if (retirement.timedOut) this.logError(`Timed-out feature retirement later failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    const deadline = this.createDeadline(this.runtimeDrainTimeoutMs);
    const outcome = await Promise.race([
      retirement.promise.then(() => ({ kind: "settled" as const }), (error: unknown) => ({ error, kind: "failed" as const })),
      deadline.expired.then(() => ({ kind: "deadline" as const })),
    ]);
    if (outcome.kind === "settled") { deadline.cancel(); return; }
    if (outcome.kind === "failed") { deadline.cancel(); throw outcome.error; }
    retirement.timedOut = true;
    for (const node of nodes) node.instance.expireRuntimeDrain?.();
    throw new Error(this.describeTimedOutRetirement(retirement, `New feature nodes are active, but runtime drain exceeded ${this.runtimeDrainTimeoutMs}ms`));
  }

  private async disposeNodes(nodes: readonly ActiveNode<TContext, TFeatures, TNotification>[]) {
    const errors: unknown[] = [];
    for (const node of nodes) {
      node.disposalPhase = "feature node disposal";
      try {
        await node.instance.dispose((phase) => { node.disposalPhase = boundedLabel(phase); });
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

  private describeTimedOutRetirement(retirement: Retirement<TContext, TFeatures, TNotification>, prefix: string) {
    return this.describeNodes(retirement.nodes, prefix);
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
