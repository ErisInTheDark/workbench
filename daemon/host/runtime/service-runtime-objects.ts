/*
 * Exports:
 * - ServiceRuntimeObjects: registrations owned by the host reload graph.
 */
import type ReloadDirtController from "../../../shared/reload/ReloadDirtController.ts";
import type WorkbenchServiceRepository from "../WorkbenchServiceRepository.ts";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import type WorkbenchServiceReloadController from "./WorkbenchServiceReloadController.ts";
import type { ServiceHttp } from "./ServiceHttpNode.ts";

export interface ServiceRuntimeObjects {
  database: WorkbenchServiceRepository;
  network: WorkbenchNetworkController;
  dirt: ReloadDirtController;
  reload: WorkbenchServiceReloadController;
  http: ServiceHttp;
}
