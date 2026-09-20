/*
 * Exports:
 * - WorkbenchAccountSnapshot: immutable provider model and rate-limit cache projection.
 * - WorkbenchAccountClientOptions: provider account transport and diagnostic ports.
 * - default WorkbenchAccountClient: own model caches and rate-limit refresh lifecycle by harness.
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

const AUTO_REFRESH_INTERVAL_MS = 15_000;

type RateLimitEntry = {
  generation: number;
  snapshot: WorkbenchRateLimitSnapshot | null;
  source: "notification" | "read";
};

export interface WorkbenchAccountSnapshot {
  modelsByHarness: ReadonlyMap<WorkbenchHarness, readonly WorkbenchModelOption[]>;
  rateLimitsByHarness: ReadonlyMap<WorkbenchHarness, WorkbenchRateLimitSnapshot | null>;
}

export interface WorkbenchAccountClientOptions {
  listModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  now?: () => number;
  reportError?: (message: string) => void;
  readRateLimits: (harness: WorkbenchHarness) => Promise<WorkbenchAccountLimits>;
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
  private readonly generations = new Map<WorkbenchHarness, number>();
  private readonly listeners = new Set<() => void>();
  private readonly models = new Map<WorkbenchHarness, WorkbenchModelOption[]>();
  private readonly now: () => number;
  private readonly options: WorkbenchAccountClientOptions;
  private readonly rateLimits = new Map<WorkbenchHarness, RateLimitEntry>();
  private readonly refreshStartedAt = new Map<WorkbenchHarness, number>();
  private readonly refreshes = new Map<WorkbenchHarness, Promise<void>>();
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
    return harness ? this.rateLimits.get(harness)?.snapshot ?? null : null;
  }

  hasRateLimits() {
    return [...this.rateLimits.values()].some(entry => entry.snapshot !== null);
  }

  async listModels(harness: WorkbenchHarness, options: WorkbenchListModelsOptions = {}) {
    if (!installedProviderKeys.some(key => key === harness)) {
      throw new Error(`Provider ${harness} is not installed.`);
    }
    const cached = this.models.get(harness);
    if (cached && !options.forceRefresh) return cached;
    const models = await this.options.listModels(harness);
    if (!this.disposed) {
      this.models.set(harness, models);
      this.publish();
    }
    return models;
  }

  async refreshIfStale(harness: WorkbenchHarness) {
    const active = this.refreshes.get(harness);
    if (active) return await active;
    const startedAt = this.refreshStartedAt.get(harness);
    const elapsed = startedAt === undefined ? null : this.now() - startedAt;
    if (elapsed !== null && elapsed >= 0 && elapsed < AUTO_REFRESH_INTERVAL_MS) return;
    await this.refresh(harness);
  }

  async refresh(harness: WorkbenchHarness, source: RateLimitEntry["source"] = "read") {
    const active = this.refreshes.get(harness);
    if (active) return await active;
    this.refreshStartedAt.set(harness, this.now());
    const contextGeneration = this.contextGeneration;
    const generation = (this.generations.get(harness) ?? 0) + 1;
    this.generations.set(harness, generation);
    let task: Promise<void>;
    task = this.options.readRateLimits(harness)
      .then((response) => {
        if (
          this.disposed
          || contextGeneration !== this.contextGeneration
          || generation < (this.generations.get(harness) ?? 0)
        ) return;
        const previous = this.rateLimits.get(harness);
        const next = selectRateLimits(response, previous?.snapshot ?? null);
        if (previous && generation === previous.generation && previous.source === "notification" && source === "read") return;
        if (isRegressive(previous?.snapshot ?? null, next, this.now())) return;
        this.rateLimits.set(harness, { generation, snapshot: next, source });
        this.publish();
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : "unknown failure";
        this.options.reportError?.(`Unable to refresh ${harness} account limits: ${detail.slice(0, 500)}`);
      })
      .finally(() => {
        if (this.refreshes.get(harness) === task) this.refreshes.delete(harness);
      });
    this.refreshes.set(harness, task);
    await task;
  }

  reset() {
    this.contextGeneration += 1;
    this.generations.clear();
    this.refreshes.clear();
    this.rateLimits.clear();
    this.publish();
  }

  dispose() {
    this.disposed = true;
    this.contextGeneration += 1;
    this.generations.clear();
    this.refreshes.clear();
    this.listeners.clear();
  }

  private publish() {
    this.snapshot = {
      modelsByHarness: new Map(this.models),
      rateLimitsByHarness: new Map(
        [...this.rateLimits].map(([harness, entry]) => [harness, entry.snapshot]),
      ),
    };
    for (const listener of this.listeners) listener();
  }
}
