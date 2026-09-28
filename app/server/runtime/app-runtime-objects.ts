/*
 * Exports:
 * - AppRuntimeObjects: live registrations populated by the app reload graph.
 */
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type WorkbenchPresentationRepository from "../state/WorkbenchPresentationRepository.ts";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController.ts";
import type WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import type WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import type WorkbenchAppHttpRouter from "./WorkbenchAppHttpRouter.ts";
import type WorkbenchAppReloadController from "./WorkbenchAppReloadController.ts";
import type WorkbenchAppReloadDirtController from "./WorkbenchAppReloadDirtController.ts";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";
import type WorkbenchWorkspaceController from "../workspace/WorkbenchWorkspaceController";
import type WorkbenchWorkspaceThreads from "../workspace/WorkbenchWorkspaceThreads";
import type WorkbenchWorkspaceDrafts from "../workspace/WorkbenchWorkspaceDrafts";
import type WorkbenchPresentationImportController from "../state/WorkbenchPresentationImportController";

export interface AppRuntimeObjects {
  compiler: WorkbenchFrontendCompiler;
  database: WorkbenchAppStateRepository;
  presentationDatabase: WorkbenchPresentationRepository;
  presentation: WorkbenchPresentationController;
  http: WorkbenchAppHttpRouter;
  logger: WorkbenchProcessLogger;
  network: WorkbenchNetworkController;
  reloadController: WorkbenchAppReloadController;
  reloadDirt: WorkbenchAppReloadDirtController;
  state: WorkbenchBrowserStateRegistry;
  topology: object;
  sources: WorkbenchDaemonSources;
  workspace: WorkbenchWorkspaceController;
  workspaceThreads: WorkbenchWorkspaceThreads;
  workspaceDrafts: WorkbenchWorkspaceDrafts;
  presentationImport: WorkbenchPresentationImportController;
}
