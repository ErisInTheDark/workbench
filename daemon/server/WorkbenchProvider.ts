/*
 * Exports:
 * - default WorkbenchProvider: provider-neutral daemon capabilities.
 * - WorkbenchProviderOperation: graph entry for one awaited provider operation.
 */
import type { WorkbenchModelContextCapability } from "workbench-shared/types";
import type { WorkbenchProviderRegistration } from "workbench-shared/workbench/provider/provider-registrations";

export default interface WorkbenchProvider {
  readonly configuration: {
    readonly modelContext: {
      read(): Promise<WorkbenchModelContextCapability[]>;
    };
  };
}

export type WorkbenchProviderOperation = <T>(
  registration: WorkbenchProviderRegistration,
  operation: (provider: WorkbenchProvider) => Promise<T> | T,
  label: string,
) => Promise<T>;
