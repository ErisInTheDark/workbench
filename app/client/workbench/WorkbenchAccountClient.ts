/*
 * Exports:
 * - WorkbenchAccountSnapshot: immutable provider model and rate-limit cache projection.
 * - WorkbenchRateLimitObservation: one provider's daemon-owned limits observation.
 * - WorkbenchAccountClientOptions: provider account transport and diagnostic ports.
 * - WorkbenchModelReadSupersededError: expected retirement of an obsolete model read.
 * - default WorkbenchAccountClient: own model caches and watched providers' daemon-pushed rate limits by harness.
 */
import type {
  WorkbenchHarness,
  WorkbenchListModelsOptions,
  WorkbenchModelOption,
} from "workbench-shared/types";
import type {
  WorkbenchAccountLimits,
  WorkbenchRateLimitSnapshot,
} from "workbench-shared/workbench/provider/provider-account";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";

export interface WorkbenchAccountSnapshot {
  modelsByHarness: ReadonlyMap<WorkbenchHarness, readonly WorkbenchModelOption[]>;
  rateLimitsByHarness: ReadonlyMap<WorkbenchHarness, WorkbenchRateLimitSnapshot | null>;
}

/** One provider's daemon-owned limits observation; `changed` fires on every new fact. */
export type WorkbenchRateLimitObservation = {
  getSnapshot(): { failure: string | null; limits: WorkbenchAccountLimits | null };
  release(): void;
};

type RateLimitWatch = { observation: WorkbenchRateLimitObservation | null; failure: string | null };

export interface WorkbenchAccountClientOptions {
  listModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  now?: () => number;
  reportError?: (message: string) => void;
  observeRateLimits: (harness: WorkbenchHarness, changed: () => void) => WorkbenchRateLimitObservation;
}

export class WorkbenchModelReadSupersededError extends Error {
  constructor() {
    super("Model read was superseded by a newer source state.");
    this.name = "WorkbenchModelReadSupersededError";
  }
}

function remainingPercent(window: WorkbenchRateLimitSnapshot["primary"]) {
  return window ? 100 - window.usedPercent : null;
}

function windowRolledOver(
  previous: WorkbenchRateLimitSnapshot["primary"],
  next: WorkbenchRateLimitSnapshot["primary"],
  now: number,
) {
  if (!previous || !next) return false;
  const previousResetMs = previous.resetsAt === null ? null : previous.resetsAt * 1_000;
  const nextResetMs = next.resetsAt === null ? null : next.resetsAt * 1_000;
  if (previousResetMs !== null && previousResetMs <= now) return true;
  return previousResetMs !== null
    && nextResetMs !== null
    && nextResetMs > previousResetMs
    && remainingPercent(previous) !== null
    && remainingPercent(previous)! <= 1;
}

function isRegressive(
  previous: WorkbenchRateLimitSnapshot | null,
  next: WorkbenchRateLimitSnapshot | null,
  now: number,
) {
  if (!previous?.primary || !next?.primary
    || previous.primary.windowDurationMins !== next.primary.windowDurationMins) return false;
  const previousRemaining = remainingPercent(previous.primary);
  const nextRemaining = remainingPercent(next.primary);
  return previousRemaining !== null
    && nextRemaining !== null
    && nextRemaining > previousRemaining
    && !windowRolledOver(previous.primary, next.primary, now);
}

function selectRateLimits(
  response: WorkbenchAccountLimits,
  previous: WorkbenchRateLimitSnapshot | null,
) {
  const legacy = response.rateLimits as WorkbenchRateLimitSnapshot | null;
  const byId = response.rateLimitsByLimitId ?? {};
  if (!response.preferredLimitId) return legacy;
  return byId[response.preferredLimitId]
    ?? (previous?.limitId ? byId[previous.limitId] : undefined)
    ?? (legacy?.limitId ? byId[legacy.limitId] : undefined)
    ?? Object.values(byId)[0]
    ?? legacy;
}

export default class WorkbenchAccountClient {
  private contextGeneration = 0;
  private readonly listeners = new Set<() => void>();
  private readonly models = new Map<WorkbenchHarness, WorkbenchModelOption[]>();
  private readonly modelReads = new Map<WorkbenchHarness, Promise<WorkbenchModelOption[]>>();
  private readonly now: () => number;
  private readonly options: WorkbenchAccountClientOptions;
  private readonly rateLimits = new Map<WorkbenchHarness, WorkbenchRateLimitSnapshot | null>();
  /** Watched providers' daemon observations; the daemon decides when limits are reread. */
  private readonly rateLimitObservations = new Map<WorkbenchHarness, RateLimitWatch>();
  private snapshot: WorkbenchAccountSnapshot = {
    modelsByHarness: new Map(),
    rateLimitsByHarness: new Map(),
  };
  private disposed = false;

  constructor(options: WorkbenchAccountClientOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  getModels(harness: WorkbenchHarness) {
    return this.models.get(harness) ?? [];
  }

  getRateLimits(harness: WorkbenchHarness | null | undefined) {
    return harness ? this.rateLimits.get(harness) ?? null : null;
  }

  hasRateLimits() {
    return [...this.rateLimits.values()].some(snapshot => snapshot !== null);
  }

  async listModels(harness: WorkbenchHarness, options: WorkbenchListModelsOptions = {}) {
    if (!installedProviderKeys.some(key => key === harness)) {
      throw new Error(`Provider ${harness} is not installed.`);
    }
    const cached = this.models.get(harness);
    if (cached && !options.forceRefresh) return cached;
    const pending = this.modelReads.get(harness);
    if (pending && !options.forceRefresh) return pending;
    const generation = this.contextGeneration;
    const read = this.options.listModels(harness).then(models => {
      if (this.disposed || generation !== this.contextGeneration || this.modelReads.get(harness) !== read) {
        const current = this.models.get(harness);
        if (current && !this.disposed) return current;
        throw new WorkbenchModelReadSupersededError();
      }
      this.models.set(harness, models);
      this.publish();
      return models;
    }).finally(() => {
      if (this.modelReads.get(harness) === read) this.modelReads.delete(harness);
    });
    this.modelReads.set(harness, read);
    return read;
  }

  invalidateModels(harness: WorkbenchHarness) {
    this.models.delete(harness);
    this.modelReads.delete(harness);
    this.publish();
  }

  /**
   * Show a provider's limits: holds its daemon observation until reset or disposal. The daemon rereads on demand,
   * while the provider is active and slowly when idle, so watching again is free.
   */
  watchRateLimits(harness: WorkbenchHarness) {
    if (this.disposed || this.rateLimitObservations.has(harness)) return;
    // Opening may answer synchronously, so the entry exists before its observation does.
    const entry: RateLimitWatch = { observation: null, failure: null };
    const accept = () => {
      const current = this.rateLimitObservations.get(harness);
      if (this.disposed || !current || current !== entry) return;
      const fact = current.observation?.getSnapshot();
      if (!fact) return;
      if (fact.failure && fact.failure !== current.failure) {
        this.options.reportError?.(`Unable to refresh ${harness} account limits: ${fact.failure.slice(0, 500)}`);
      }
      current.failure = fact.failure;
      if (!fact.limits) return;
      const previous = this.rateLimits.get(harness) ?? null;
      const next = selectRateLimits(fact.limits, previous);
      if (isRegressive(previous, next, this.now())) return;
      this.rateLimits.set(harness, next);
      this.publish();
    };
    this.rateLimitObservations.set(harness, entry);
    entry.observation = this.options.observeRateLimits(harness, accept);
    accept();
  }

  reset() {
    this.contextGeneration += 1;
    this.releaseRateLimitObservations();
    this.models.clear();
    this.modelReads.clear();
    this.rateLimits.clear();
    this.publish();
  }

  dispose() {
    this.disposed = true;
    this.contextGeneration += 1;
    this.releaseRateLimitObservations();
    this.modelReads.clear();
    this.listeners.clear();
  }

  private releaseRateLimitObservations() {
    for (const { observation } of this.rateLimitObservations.values()) observation?.release();
    this.rateLimitObservations.clear();
  }

  private publish() {
    this.snapshot = {
      modelsByHarness: new Map(this.models),
      rateLimitsByHarness: new Map(this.rateLimits),
    };
    for (const listener of this.listeners) listener();
  }
}
