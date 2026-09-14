/*
 * Exports:
 * - default WorkbenchProviderHandle: forward each operation through the current definition lease.
 */
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchProviderOperation } from "./WorkbenchProvider";
import providerRegistrations, { type WorkbenchProviderKey } from "./provider-registrations";

export default class WorkbenchProviderHandle implements WorkbenchProvider {
  constructor(
    private readonly key: WorkbenchProviderKey,
    private readonly run: WorkbenchProviderOperation,
  ) {}

  readonly configuration: WorkbenchProvider["configuration"] = {
    modelContext: {
      read: () => this.run(
        providerRegistrations[this.key],
        (provider) => provider.configuration.modelContext.read(),
        `${this.key}: configuration.modelContext.read`,
      ),
    },
  };
}
