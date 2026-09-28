/*
 * Exports:
 * - default WorkbenchAppBootstrap: mountable app owners with independent connection, runtime and browser-state binding.
 */
import type { WorkbenchFrontendGeneration } from "workbench-shared/types";
import WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";
import WorkbenchWorkspaceClient from "./WorkbenchWorkspaceClient";
import WorkbenchAppRuntimeClient from "./WorkbenchAppRuntimeClient";
import WorkbenchClientStateController from "../state/WorkbenchClientStateController";
import { readWorkbenchAppPort } from "./workbench-app-port-client";
import { resolveWorkbenchBrowserStateIdentity } from "../state/workbench-browser-state-identity";

export default class WorkbenchAppBootstrap {
  readonly rpc: WorkbenchAppRpcClient;
  readonly workspace: WorkbenchWorkspaceClient;
  readonly runtime: WorkbenchAppRuntimeClient;
  readonly state: WorkbenchClientStateController;
  private readonly unsubscribe: Array<() => void> = [];
  private bound = false;
  private disposed = false;

  constructor(options: {
    loadedFrontendGeneration: WorkbenchFrontendGeneration | null;
    rpc?: WorkbenchAppRpcClient;
  }) {
    this.rpc = options.rpc ?? new WorkbenchAppRpcClient();
    this.workspace = new WorkbenchWorkspaceClient(this.rpc);
    this.runtime = new WorkbenchAppRuntimeClient({
      workspace: this.workspace, loadedFrontendGeneration: options.loadedFrontendGeneration,
    });
    this.state = new WorkbenchClientStateController({ workspace: this.workspace });
  }

  start() {
    this.unsubscribe.push(this.rpc.onOpen(() => {
      if (this.bound || this.disposed) return;
      const generation = this.rpc.getSnapshot().generation;
      void readWorkbenchAppPort(this.rpc).then(async snapshot => {
        if (this.disposed || this.bound || generation !== this.rpc.getSnapshot().generation) return;
        const identity = resolveWorkbenchBrowserStateIdentity(snapshot);
        if (identity.cleanedHref) window.history.replaceState(window.history.state, "", identity.cleanedHref);
        await this.state.bindBrowserState(identity.browserStateId);
        this.bound = true;
      }).catch(error => {
        if (!this.disposed) console.error("Browser state binding failed.",
          error instanceof Error ? error.message.slice(0, 512) : "Invalid app identity.");
      });
    }));
    this.unsubscribe.push(this.state.subscribe(() => {
      const theme = this.state.records("globalPreference").find(record => record.preference.key === "theme")?.preference.value;
      document.documentElement.dataset.workbenchTheme = theme === "magical-girl" || theme === "winter" ? theme : "default";
    }));
    void this.runtime.bootstrap();
    this.rpc.start();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.unsubscribe) stop();
    this.state.dispose();
    this.runtime.dispose();
    this.workspace.dispose();
    this.rpc.dispose();
  }
}
