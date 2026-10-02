/*
 * Exports:
 * - default WorkbenchHarnessController: resolve shared identities and hydrate stats usage through installed providers.
 * - WorkbenchHarnessControllerOptions: shared identity and provider operation owners.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsHydrationResult } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchStatsUsageImportCandidate } from "./database/stats/WorkbenchStatsImportRepository";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type { WorkbenchThreadIdentityLookup } from "./database/thread-identity/workbench-thread-identity-types";
import type { WorkbenchTurnIdentityLookup } from "./database/thread-identity/workbench-thread-identity-types";
import type WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import { defaultProviderKey, installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";

export interface WorkbenchHarnessControllerOptions {
  providers: Pick<WorkbenchProviderDispatcher, "get" | "hydratesUsage">;
  identities: WorkbenchThreadIdentityController;
}

export default class WorkbenchHarnessController {
  private readonly identities: WorkbenchHarnessControllerOptions["identities"];
  private readonly providers: WorkbenchHarnessControllerOptions["providers"];

  constructor(options: WorkbenchHarnessControllerOptions) {
    this.identities = options.identities;
    this.providers = options.providers;
  }

  listHarnesses() {
    return [...installedProviderKeys];
  }

  /** Providers whose current definition can backfill usage; a provider that fails to open sits this run out. */
  async listUsageHydrationHarnesses(): Promise<WorkbenchHarness[]> {
    const probes = await Promise.allSettled(installedProviderKeys.map(key => this.providers.hydratesUsage(key)));
    return installedProviderKeys.filter((key, index) => {
      const probe = probes[index]!;
      if (probe.status === "fulfilled") return probe.value;
      console.warn(`[stats] ${key} usage hydration is unavailable for this import run:`,
        probe.reason instanceof Error ? probe.reason.message.slice(0, 300) : "unknown failure");
      return false;
    });
  }

  async hydrateUsage(candidate: WorkbenchStatsUsageImportCandidate): Promise<WorkbenchStatsHydrationResult> {
    const usage = this.provider(candidate.harness).usage;
    if (!usage) throw new Error(`Usage hydration is unavailable for ${candidate.harness} threads.`);
    return await usage.hydrate(candidate.threadId);
  }

  resolveHarness(value: unknown) {
    const key = installedProviderKeys.find(candidate => candidate === value);
    if (!key) throw new Error(`Unknown Workbench provider: ${typeof value === "string" && value ? value : "missing"}.`);
    return key;
  }

  async resolveThreadIdentity(
    input: WorkbenchThreadIdentityLookup,
    { allowProviderAdmission = true }: { allowProviderAdmission?: boolean } = {},
  ) {
    const known = await this.identities.resolve(input);
    if (known) return known;
    if (!allowProviderAdmission) return null;
    const harness = this.resolveHarness(input.harness || defaultProviderKey);
    await this.provider(harness).threads.read(input.threadId);
    return await this.identities.resolve(input);
  }

  async resolveTurnIdentity(input: WorkbenchThreadIdentityLookup & Pick<WorkbenchTurnIdentityLookup, "turnId">) {
    const thread = await this.resolveThreadIdentity(input);
    if (!thread) throw new Error("Thread metadata is unavailable for turn identity resolution.");
    const known = await this.identities.resolveTurn({ threadId: thread.threadId, turnId: input.turnId });
    if (known) return known;
    const harness = this.resolveHarness(input.harness || defaultProviderKey);
    await this.provider(harness).threads.admitTurn(input.threadId, input.turnId);
    return this.identities.resolveTurn({ threadId: thread.threadId, turnId: input.turnId });
  }

  private provider(harness: WorkbenchHarness) {
    const key = installedProviderKeys.find(candidate => candidate === harness);
    if (!key) throw new Error("Provider identity operations are unavailable.");
    return this.providers.get(key);
  }

}
