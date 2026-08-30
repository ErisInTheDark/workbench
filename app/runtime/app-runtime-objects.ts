/*
 * Exports:
 * - AppRuntimeObjects: live registrations populated by the app reload graph. Keywords: app, reload, registry.
 */
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateController from "../state/WorkbenchAppStateController.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type WorkbenchAppHttpRouter from "./WorkbenchAppHttpRouter.ts";
import type WorkbenchAppReloadController from "./WorkbenchAppReloadController.ts";
import type WorkbenchAppReloadDirtController from "./WorkbenchAppReloadDirtController.ts";

export interface AppRuntimeObjects {
  compiler: WorkbenchFrontendCompiler;
  database: WorkbenchAppStateRepository;
  http: WorkbenchAppHttpRouter;
  reloadController: WorkbenchAppReloadController;
  reloadDirt: WorkbenchAppReloadDirtController;
  state: WorkbenchAppStateController;
  topology: object;
}
