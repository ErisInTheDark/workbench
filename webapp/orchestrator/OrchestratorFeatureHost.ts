/*
 * Exports:
 * - OrchestratorFeatureLease: generation token used to fence late outward effects after a reload swap. Keywords: reload, generation, fence.
 * - OrchestratorFeatureRuntimeDrainPending: bounded old-generation context for drain diagnostics. Keywords: reload, drain, diagnostics.
 * - OrchestratorFeatureGeneration: one prepared reloadable feature graph with typed lookup and lifecycle hooks. Keywords: registry, lifecycle, notification.
 * - OrchestratorFeatureModule: factory exported by the reloadable registry root. Keywords: module, generation, create.
 * - OrchestratorFeatureModuleLoader: stable initial/fresh registry loader boundary. Keywords: require cache, reload.
 * - OrchestratorFeatureHostOptions: deadline, clock, logging, and swap ports owned by the process host. Keywords: reload, drain, deadline, ports.
 * - default OrchestratorFeatureHost: serialize reloads, atomically swap generations, diagnose drain, and dispose superseded features. Keywords: host, atomic swap, drain, rollback.
 */
export interface OrchestratorFeatureLease {
  isCurrent(): boolean;
}

export interface OrchestratorFeatureRuntimeDrainPending {
  ageMs: number;
  label: string;
}

export interface OrchestratorFeatureGeneration<TFeatures extends object, TNotification> {
  beginRuntimeDrain?(): void;
  dispose(reportPhase?: (phase: string) => void): Promise<void> | void;
  expireRuntimeDrain?(): void;
  get<TKey extends keyof TFeatures>(key: TKey): TFeatures[TKey];
  listRuntimeDrainPending?(): readonly OrchestratorFeatureRuntimeDrainPending[];
  observeProviderNotification?(notification: TNotification): Promise<void> | void;
  start(): Promise<void> | void;
}

export interface OrchestratorFeatureModule<TContext, TFeatures extends object, TNotification> {
  createOrchestratorFeatureGeneration(
    context: TContext,
    lease: OrchestratorFeatureLease,
  ): OrchestratorFeatureGeneration<TFeatures, TNotification>;
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
  onSwap?: () => Promise<void> | void;
  runtimeDrainTimeoutMs?: number;
}

interface ActiveOperation {
  label: string;
  startedAt: number;
}

interface ActiveGeneration<TFeatures extends object, TNotification> {
  activeOperations: Map<symbol, ActiveOperation>;
  disposalPhase: string | null;
  drainWaiters: Array<() => void>;
  generation: OrchestratorFeatureGeneration<TFeatures, TNotification>;
  runtimeDrainStartedAt: number | null;
  token: symbol;
}

interface Retirement<TFeatures extends object, TNotification> {
  active: ActiveGeneration<TFeatures, TNotification>;
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

export default class OrchestratorFeatureHost<TContext, TFeatures extends object, TNotification> {
  private current: ActiveGeneration<TFeatures, TNotification>;
  private currentToken: symbol | null = null;
  private readonly createDeadline: NonNullable<OrchestratorFeatureHostOptions["createRuntimeDrainDeadline"]>;
  private readonly logError: NonNullable<OrchestratorFeatureHostOptions["logError"]>;
  private readonly now: NonNullable<OrchestratorFeatureHostOptions["now"]>;
  private readonly onSwap: NonNullable<OrchestratorFeatureHostOptions["onSwap"]>;
  private reloadTail = Promise.resolve();
  private readonly retirements = new Set<Retirement<TFeatures, TNotification>>();
  private readonly runtimeDrainTimeoutMs: number;
  private started = false;

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
    this.current = this.createActiveGeneration(loader.load());
    this.currentToken = this.current.token;
  }

  get<TKey extends keyof TFeatures>(key: TKey) {
    return this.current.generation.get(key);
  }

  async run<TKey extends keyof TFeatures, TResult>(
    key: TKey,
    operation: (feature: TFeatures[TKey]) => Promise<TResult> | TResult,
    label = String(key),
  ) {
    const active = this.current;
    const token = Symbol("orchestrator-feature-operation");
    active.activeOperations.set(token, { label: boundedLabel(label), startedAt: this.now() });
    try {
      return await operation(active.generation.get(key));
    } finally {
      active.activeOperations.delete(token);
      this.resolveDrain(active);
    }
  }

  async start() {
    if (this.started) return;
    await this.current.generation.start();
    this.started = true;
  }

  async reload() {
    const operation = this.reloadTail.then(async () => {
      const blocked = Array.from(this.retirements).find((retirement) => retirement.timedOut && !retirement.settled);
      if (blocked) throw new Error(this.describeTimedOutRetirement(blocked, "A previous feature generation still has timed-out runtime retirement"));

      const previous = this.current;
      const candidate = this.createActiveGeneration(this.loader.reload());
      this.current = candidate;
      this.currentToken = candidate.token;
      try {
        if (this.started) await candidate.generation.start();
      } catch (error) {
        this.current = previous;
        this.currentToken = previous.token;
        await candidate.generation.dispose();
        throw error;
      }
      await this.onSwap();

      const retirement = this.createRetirement(previous);
      const deadline = this.createDeadline(this.runtimeDrainTimeoutMs);
      const outcome = await Promise.race([
        retirement.promise.then(
          () => ({ kind: "settled" as const }),
          (error: unknown) => ({ error, kind: "failed" as const }),
        ),
        deadline.expired.then(() => ({ kind: "deadline" as const })),
      ]);
      if (outcome.kind === "settled") {
        deadline.cancel();
        return;
      }
      if (outcome.kind === "failed") {
        deadline.cancel();
        throw outcome.error;
      }

      retirement.timedOut = true;
      previous.generation.expireRuntimeDrain?.();
      throw new Error(this.describeTimedOutRetirement(retirement, `New feature generation is active, but runtime drain exceeded ${this.runtimeDrainTimeoutMs}ms`));
    });
    this.reloadTail = operation.catch(() => undefined);
    return await operation;
  }

  async observeProviderNotification(notification: TNotification, label = "provider notification") {
    const active = this.current;
    const token = Symbol("orchestrator-provider-notification");
    active.activeOperations.set(token, { label: boundedLabel(label), startedAt: this.now() });
    try {
      await active.generation.observeProviderNotification?.(notification);
    } finally {
      active.activeOperations.delete(token);
      this.resolveDrain(active);
    }
  }

  async dispose() {
    await this.reloadTail;
    const active = this.current;
    this.currentToken = null;
    active.runtimeDrainStartedAt = this.now();
    active.generation.beginRuntimeDrain?.();
    await this.waitForDrain(active);
    await active.generation.dispose();
  }

  private createActiveGeneration(module: OrchestratorFeatureModule<TContext, TFeatures, TNotification>): ActiveGeneration<TFeatures, TNotification> {
    const token = Symbol("orchestrator-feature-generation");
    return {
      activeOperations: new Map(),
      disposalPhase: null,
      drainWaiters: [],
      generation: module.createOrchestratorFeatureGeneration(this.context, {
        isCurrent: () => this.currentToken === token,
      }),
      runtimeDrainStartedAt: null,
      token,
    };
  }

  private createRetirement(active: ActiveGeneration<TFeatures, TNotification>): Retirement<TFeatures, TNotification> {
    active.runtimeDrainStartedAt = this.now();
    active.generation.beginRuntimeDrain?.();
    const retirement = {
      active,
      promise: Promise.resolve(),
      settled: false,
      timedOut: false,
    } as Retirement<TFeatures, TNotification>;
    retirement.promise = (async () => {
      await this.waitForDrain(active);
      active.disposalPhase = "feature generation disposal";
      await active.generation.dispose((phase) => { active.disposalPhase = boundedLabel(phase); });
      active.disposalPhase = null;
    })();
    this.retirements.add(retirement);
    void retirement.promise.then(
      () => {
        retirement.settled = true;
        this.retirements.delete(retirement);
      },
      (error: unknown) => {
        retirement.settled = true;
        this.retirements.delete(retirement);
        if (retirement.timedOut) this.logError(`Timed-out feature retirement later failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return retirement;
  }

  private describeTimedOutRetirement(retirement: Retirement<TFeatures, TNotification>, prefix: string) {
    const active = retirement.active;
    const now = this.now();
    const pending = Array.from(active.activeOperations.values(), ({ label, startedAt }) => `${label} (${Math.max(0, now - startedAt)}ms)`);
    if (active.disposalPhase) {
      const startedAt = active.runtimeDrainStartedAt ?? now;
      pending.push(`${active.disposalPhase} (${Math.max(0, now - startedAt)}ms drain age)`);
    }
    for (const context of active.generation.listRuntimeDrainPending?.() ?? []) {
      pending.push(`${boundedLabel(context.label)} (${Math.max(0, context.ageMs)}ms MCP context)`);
    }
    return `${prefix}. Pending: ${pending.length ? pending.join(", ") : "retirement completion did not settle"}.`;
  }

  private resolveDrain(active: ActiveGeneration<TFeatures, TNotification>) {
    if (active.activeOperations.size !== 0) return;
    for (const resolve of active.drainWaiters.splice(0)) resolve();
  }

  private async waitForDrain(active: ActiveGeneration<TFeatures, TNotification>) {
    if (active.activeOperations.size === 0) return;
    await new Promise<void>((resolve) => active.drainWaiters.push(resolve));
  }
}
