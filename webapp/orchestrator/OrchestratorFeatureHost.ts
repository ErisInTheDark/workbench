/*
 * Exports:
 * - OrchestratorFeatureLease: generation token used to fence late outward effects after a reload swap. Keywords: reload, generation, fence.
 * - OrchestratorFeatureGeneration: one prepared reloadable feature graph with typed lookup and lifecycle hooks. Keywords: registry, lifecycle, notification.
 * - OrchestratorFeatureModule: factory exported by the reloadable registry root. Keywords: module, generation, create.
 * - OrchestratorFeatureModuleLoader: stable initial/fresh registry loader boundary. Keywords: require cache, reload.
 * - default OrchestratorFeatureHost: serialize reloads, atomically swap generations, drain in-flight work, and dispose superseded features. Keywords: host, atomic swap, drain, rollback.
 */
export interface OrchestratorFeatureLease {
  isCurrent(): boolean;
}

export interface OrchestratorFeatureGeneration<TFeatures extends object, TNotification> {
  dispose(): Promise<void> | void;
  get<TKey extends keyof TFeatures>(key: TKey): TFeatures[TKey];
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

interface ActiveGeneration<TFeatures extends object, TNotification> {
  activeCalls: number;
  drainWaiters: Array<() => void>;
  generation: OrchestratorFeatureGeneration<TFeatures, TNotification>;
  token: symbol;
}

export default class OrchestratorFeatureHost<TContext, TFeatures extends object, TNotification> {
  private current: ActiveGeneration<TFeatures, TNotification>;
  private currentToken: symbol | null = null;
  private reloadTail = Promise.resolve();
  private started = false;

  constructor(
    private readonly context: TContext,
    private readonly loader: OrchestratorFeatureModuleLoader<TContext, TFeatures, TNotification>,
    private readonly onSwap: () => Promise<void> | void = () => undefined,
  ) {
    this.current = this.createActiveGeneration(loader.load());
    this.currentToken = this.current.token;
  }

  get<TKey extends keyof TFeatures>(key: TKey) {
    return this.current.generation.get(key);
  }

  async run<TKey extends keyof TFeatures, TResult>(
    key: TKey,
    operation: (feature: TFeatures[TKey]) => Promise<TResult> | TResult,
  ) {
    const active = this.current;
    active.activeCalls += 1;
    try {
      return await operation(active.generation.get(key));
    } finally {
      active.activeCalls -= 1;
      if (active.activeCalls === 0) {
        for (const resolve of active.drainWaiters.splice(0)) resolve();
      }
    }
  }

  async start() {
    if (this.started) return;
    await this.current.generation.start();
    this.started = true;
  }

  async reload() {
    const operation = this.reloadTail.then(async () => {
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
      await this.waitForDrain(previous);
      await previous.generation.dispose();
    });
    this.reloadTail = operation.catch(() => undefined);
    return await operation;
  }

  async observeProviderNotification(notification: TNotification) {
    const active = this.current;
    active.activeCalls += 1;
    try {
      await active.generation.observeProviderNotification?.(notification);
    } finally {
      active.activeCalls -= 1;
      if (active.activeCalls === 0) {
        for (const resolve of active.drainWaiters.splice(0)) resolve();
      }
    }
  }

  async dispose() {
    await this.reloadTail;
    const active = this.current;
    this.currentToken = null;
    await this.waitForDrain(active);
    await active.generation.dispose();
  }

  private createActiveGeneration(module: OrchestratorFeatureModule<TContext, TFeatures, TNotification>): ActiveGeneration<TFeatures, TNotification> {
    const token = Symbol("orchestrator-feature-generation");
    return {
      activeCalls: 0,
      drainWaiters: [],
      generation: module.createOrchestratorFeatureGeneration(this.context, {
        isCurrent: () => this.currentToken === token,
      }),
      token,
    };
  }

  private async waitForDrain(active: ActiveGeneration<TFeatures, TNotification>) {
    if (active.activeCalls === 0) return;
    await new Promise<void>((resolve) => active.drainWaiters.push(resolve));
  }
}
