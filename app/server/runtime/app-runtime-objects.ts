/*
 * Exports:
 * - AppRuntimeObjects: live registrations populated by the app reload graph.
 */
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import type WorkbenchAppHttpRouter from "./WorkbenchAppHttpRouter.ts";
import type WorkbenchAppReloadController from "./WorkbenchAppReloadController.ts";
import type WorkbenchAppReloadDirtController from "./WorkbenchAppReloadDirtController.ts";

export interface AppRuntimeObjects {
  compiler: WorkbenchFrontendCompiler;
  database: WorkbenchAppStateRepository;
  http: WorkbenchAppHttpRouter;
  logger: WorkbenchProcessLogger;
  network: WorkbenchNetworkController;
  reloadController: WorkbenchAppReloadController;
  reloadDirt: WorkbenchAppReloadDirtController;
  state: WorkbenchBrowserStateRegistry;
  topology: object;
}
