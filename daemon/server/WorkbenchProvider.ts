/*
 * Exports:
 * - default WorkbenchProvider: provider-neutral daemon capabilities.
 * - WorkbenchProviderOperation: graph entry for one awaited provider operation.
 */
import type { WorkbenchModelContextCapability, WorkbenchModelOption } from "workbench-shared/types";
import type { WorkbenchProviderRegistration } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchProviderGoals } from "workbench-shared/workbench/provider/provider-goal";
import type { WorkbenchAccountLimits } from "workbench-shared/workbench/provider/provider-account";
import type { WorkbenchProviderInteractions } from "workbench-shared/workbench/provider/provider-interaction";
import type { WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";
import type { WorkbenchProviderBrowse } from "workbench-shared/workbench/provider/provider-browse";
import type { WorkbenchProviderSandboxNetwork } from "workbench-shared/workbench/provider/provider-settings";
import type { WorkbenchProviderRecovery } from "workbench-shared/workbench/provider/provider-recovery";

export default interface WorkbenchProvider {
  readonly threads: WorkbenchProviderThreads;
  readonly goals?: WorkbenchProviderGoals;
  readonly interactions?: WorkbenchProviderInteractions;
  readonly tools?: WorkbenchProviderTools;
  readonly browse?: WorkbenchProviderBrowse;
  readonly recovery?: WorkbenchProviderRecovery;
  readonly account?: { limits: { read(): Promise<WorkbenchAccountLimits> } };
  readonly configuration: {
    readonly sandboxNetwork?: WorkbenchProviderSandboxNetwork;
    readonly modelContext: {
      read(): Promise<WorkbenchModelContextCapability[]>;
    };
    readonly models: { read(): Promise<WorkbenchModelOption[]> };
    readonly guidance: { contains(sections: string[]): Promise<boolean[]> };
  };
}

export type WorkbenchProviderOperation = <T>(
  registration: WorkbenchProviderRegistration,
  operation: (provider: WorkbenchProvider) => Promise<T> | T,
  label: string,
) => Promise<T>;
