/*
 * Exports:
 * - WorkbenchOrchestratorReloadControllerLoader: fresh coordinator module loader contract. Keywords: reload, module, generation.
 * - default ReloadableWorkbenchOrchestratorReloadController: stable registration boundary for coordinator requests and self-reload handoff. Keywords: reload, coordinator, handoff.
 */
import type { OrchestratorReloadResponse, OrchestratorReloadScope } from "../lib/types";
import type WorkbenchOrchestratorReloadController from "./WorkbenchOrchestratorReloadController";
import type {
  WorkbenchOrchestratorReloadControllerOptions,
  WorkbenchOrchestratorReloadControllerState,
  WorkbenchReloadRequest,
} from "./WorkbenchOrchestratorReloadController";

type ControllerConstructor = new (options: WorkbenchOrchestratorReloadControllerOptions) => WorkbenchOrchestratorReloadController;

export interface WorkbenchOrchestratorReloadControllerLoader {
  load(): ControllerConstructor;
  reload(): ControllerConstructor;
}

interface ReloadableControllerOptions extends Omit<WorkbenchOrchestratorReloadControllerOptions, "executeBatch" | "initialState"> {
  executeScopes(scopes: OrchestratorReloadScope[]): Promise<void>;
  loader?: WorkbenchOrchestratorReloadControllerLoader;
}

const CONTROLLER_SPECIFIER = "./WorkbenchOrchestratorReloadController";

function collectCacheSubtree(moduleId: string, visited = new Set<string>()) {
  if (visited.has(moduleId)) return visited;
  const cachedModule = require.cache[moduleId];
  if (!cachedModule) return visited;
  visited.add(moduleId);
  for (const child of cachedModule.children) {
    if (child?.id && !/[\\/]node_modules[\\/]/u.test(child.id)) collectCacheSubtree(child.id, visited);
  }
  return visited;
}

function createDefaultLoader(): WorkbenchOrchestratorReloadControllerLoader {
  const load = () => (require(CONTROLLER_SPECIFIER) as typeof import("./WorkbenchOrchestratorReloadController")).default;
  return {
    load,
    reload: () => {
      const controllerId = require.resolve(CONTROLLER_SPECIFIER);
      for (const moduleId of collectCacheSubtree(controllerId)) delete require.cache[moduleId];
      return load();
    },
  };
}

export default class ReloadableWorkbenchOrchestratorReloadController {
  private current: WorkbenchOrchestratorReloadController;
  private executionTail = Promise.resolve();
  private readonly loader: WorkbenchOrchestratorReloadControllerLoader;

  constructor(private readonly options: ReloadableControllerOptions) {
    this.loader = options.loader ?? createDefaultLoader();
    this.current = this.createController(this.loader.load());
  }

  async request(input: WorkbenchReloadRequest, signal: AbortSignal): Promise<OrchestratorReloadResponse> {
    return await this.current.request(input, signal);
  }

  notifyEligibilityChanged() {
    this.current.notifyEligibilityChanged();
  }

  admitHardReload() {
    return this.current.admitHardReload();
  }

  cancelHardReloadAdmission() {
    this.current.cancelHardReloadAdmission();
  }

  isHardReloadPending() {
    return this.current.isHardReloadPending();
  }

  async beginHardReload() {
    await this.current.beginHardReload();
  }

  async executeUnmanaged(scopes: OrchestratorReloadScope[]) {
    await this.runExclusive(async () => await this.performBatch(scopes));
  }

  dispose() {
    this.current.dispose();
  }

  private createController(Controller: ControllerConstructor, initialState?: WorkbenchOrchestratorReloadControllerState) {
    return new Controller({
      executeBatch: async (scopes) => await this.executeBatch(scopes),
      hardReload: this.options.hardReload,
      initialState,
      listClaims: this.options.listClaims,
      now: this.options.now,
    });
  }

  private async executeBatch(scopes: OrchestratorReloadScope[]) {
    await this.runExclusive(async () => await this.performBatch(scopes));
  }

  private async performBatch(scopes: OrchestratorReloadScope[]) {
    if (!scopes.includes("server:reloader")) {
      await this.options.executeScopes(scopes);
      return;
    }
    const ordinaryScopes = scopes.filter((scope) => scope !== "server:reloader");
    if (ordinaryScopes.length) await this.options.executeScopes(ordinaryScopes);
    const previous = this.current;
    const state = previous.detachForReload();
    try {
      const replacement = this.createController(this.loader.reload(), state);
      this.current = replacement;
      replacement.completeTransferredBatch();
    } catch (error) {
      previous.resumeAfterFailedReload();
      this.current = previous;
      throw error;
    }
  }

  private async runExclusive(operation: () => Promise<void>) {
    const run = this.executionTail.then(operation);
    this.executionTail = run.catch(() => undefined);
    await run;
  }
}
