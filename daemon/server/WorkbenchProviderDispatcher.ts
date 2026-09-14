/*
 * Exports:
 * - default WorkbenchProviderDispatcher: obtain reload-safe installed provider handles.
 */
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchProviderOperation } from "./WorkbenchProvider";
import type { WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import WorkbenchProviderHandle from "./WorkbenchProviderHandle";

export default class WorkbenchProviderDispatcher {
  constructor(private readonly run: WorkbenchProviderOperation) {}

  get(key: WorkbenchProviderKey): WorkbenchProvider {
    return new WorkbenchProviderHandle(key, this.run);
  }
}
