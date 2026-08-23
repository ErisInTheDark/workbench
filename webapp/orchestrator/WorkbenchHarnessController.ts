/*
 * Exports:
 * - WorkbenchHarnessRuntimePort: stable bridge operations supplied to reloadable harness registrations. Keywords: harness, bridge, port, lifecycle.
 * - WorkbenchHarnessAdapter/WorkbenchHarnessReloadPlan: exhaustive reloadable registration and pure reload-plan contracts. Keywords: harness, capability, reload, plan.
 * - default WorkbenchHarnessController: validate registrations and own browser, server, Browse, recovery, and reload dispatch. Keywords: harness, routing, recovery, reload.
 */
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type { WorkbenchHarness } from "../lib/types";
import type { BridgeClient, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";

export interface WorkbenchHarnessRuntimePort {
  handleBrowserMessage(message: JsonRpcRequest, client: BridgeClient): Promise<void>;
  request(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  readThread(threadId: string): Promise<ThreadReadResponse>;
  steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<string | null>;
  observeRecoveryNotification?(notification: JsonRpcNotification): void;
  observeRecoveryRequest?(request: JsonRpcRequest): void;
  resumeThread?(threadId: string): Promise<void>;
  executeReload?(scopes: readonly string[]): Promise<void>;
}

export interface WorkbenchHarnessReloadScope {
  refreshWorkbenchPromptFiles: boolean;
  reloadOrchestratorLogic: boolean;
  scope: string;
}

type WorkbenchHarnessRecoveryCapability =
  | { kind: "none" }
  | {
      kind: "turn";
      observeNotification(notification: JsonRpcNotification): void;
      observeRequest(request: JsonRpcRequest): void;
      resumeThread(threadId: string): Promise<void>;
    };

type WorkbenchHarnessReloadCapability =
  | { kind: "none" }
  | {
      execute(scopes: readonly string[]): Promise<void>;
      kind: "scoped";
      scopes: readonly WorkbenchHarnessReloadScope[];
    };

export interface WorkbenchHarnessAdapter {
  browse: Pick<WorkbenchHarnessRuntimePort, "readThread" | "steerTurn">;
  browser: Pick<WorkbenchHarnessRuntimePort, "handleBrowserMessage">;
  id: WorkbenchHarness;
  internal: Pick<WorkbenchHarnessRuntimePort, "request">;
  recovery: WorkbenchHarnessRecoveryCapability;
  reload: WorkbenchHarnessReloadCapability;
  serverMethods: readonly string[];
}

export interface WorkbenchHarnessReloadPlan {
  actions: readonly { harness: WorkbenchHarness; scopes: readonly string[] }[];
  refreshWorkbenchPromptFiles: boolean;
  reloadOrchestratorLogic: boolean;
}

function requireNonEmptyUniqueValues(values: readonly string[], label: string) {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) throw new Error(`${label} cannot contain an empty value.`);
  if (normalized.some((value, index) => value !== values[index])) throw new Error(`${label} must contain canonical values without surrounding whitespace.`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} cannot contain duplicate values.`);
  return normalized;
}

export default class WorkbenchHarnessController {
  private readonly adapters: readonly WorkbenchHarnessAdapter[];
  private readonly adaptersById: ReadonlyMap<WorkbenchHarness, WorkbenchHarnessAdapter>;
  private readonly reloadScopes: ReadonlyMap<string, WorkbenchHarness>;

  constructor(adapters: readonly WorkbenchHarnessAdapter[]) {
    if (!adapters.length) throw new Error("At least one Workbench harness adapter is required.");
    const adaptersById = new Map<WorkbenchHarness, WorkbenchHarnessAdapter>();
    const reloadScopes = new Map<string, WorkbenchHarness>();
    for (const adapter of adapters) {
      if (adaptersById.has(adapter.id)) throw new Error(`Workbench harness ${adapter.id} is registered more than once.`);
      requireNonEmptyUniqueValues(adapter.serverMethods, `Workbench harness ${adapter.id} server methods`);
      if (adapter.reload.kind === "scoped") {
        const scopes = requireNonEmptyUniqueValues(adapter.reload.scopes.map(({ scope }) => scope), `Workbench harness ${adapter.id} reload scopes`);
        for (const scope of scopes) {
          const owner = reloadScopes.get(scope);
          if (owner) throw new Error(`Workbench reload scope ${scope} is registered by both ${owner} and ${adapter.id}.`);
          reloadScopes.set(scope, adapter.id);
        }
      }
      adaptersById.set(adapter.id, adapter);
    }
    if (!adaptersById.has("codex")) throw new Error("The default Codex harness adapter is required.");
    this.adapters = [...adapters];
    this.adaptersById = adaptersById;
    this.reloadScopes = reloadScopes;
  }

  listHarnesses() {
    return this.adapters.map(({ id }) => id);
  }

  resolveHarness(value: unknown, options: { defaultToCodex?: boolean } = {}) {
    if ((value === undefined || value === null || value === "") && options.defaultToCodex) return "codex" as const;
    if (typeof value !== "string" || !this.adaptersById.has(value as WorkbenchHarness)) {
      throw new Error(`Unknown Workbench harness: ${typeof value === "string" && value ? value : "missing"}.`);
    }
    return value as WorkbenchHarness;
  }

  async handleBrowserMessage(value: unknown, message: JsonRpcRequest, client: BridgeClient) {
    const adapter = this.getAdapter(this.resolveHarness(value, { defaultToCodex: true }));
    if (adapter.recovery.kind === "turn" && "id" in message) adapter.recovery.observeRequest(message);
    await adapter.browser.handleBrowserMessage(message, client);
  }

  async request(harness: WorkbenchHarness, request: JsonRpcRequest) {
    const adapter = this.getAdapter(harness);
    if (adapter.recovery.kind === "turn") adapter.recovery.observeRequest(request);
    return await adapter.internal.request(request);
  }

  async requestServer(harnessValue: unknown, request: JsonRpcRequest) {
    const harness = this.resolveHarness(harnessValue);
    const adapter = this.getAdapter(harness);
    const method = request.method?.trim() ?? "";
    if (!method || !adapter.serverMethods.includes(method)) {
      throw new Error(`Workbench bridge method ${method || "missing"} is not allowed for ${harness}.`);
    }
    return await this.request(harness, { ...request, method });
  }

  async readThread(harness: WorkbenchHarness, threadId: string) {
    return await this.getAdapter(harness).browse.readThread(threadId);
  }

  async steerTurn(harness: WorkbenchHarness, threadId: string, expectedTurnId: string, input: UserInput[]) {
    return await this.getAdapter(harness).browse.steerTurn(threadId, expectedTurnId, input);
  }

  observeNotification(harness: WorkbenchHarness, notification: JsonRpcNotification) {
    const recovery = this.getAdapter(harness).recovery;
    if (recovery.kind === "turn") recovery.observeNotification(notification);
  }

  async resumeThread(harness: WorkbenchHarness, threadId: string) {
    const recovery = this.getAdapter(harness).recovery;
    if (recovery.kind !== "turn") throw new Error(`Manual thread resume is unavailable for ${harness} threads.`);
    await recovery.resumeThread(threadId);
  }

  planReload(scopes: readonly string[]): WorkbenchHarnessReloadPlan {
    const requested = new Set(requireNonEmptyUniqueValues(scopes, "Workbench provider reload scopes"));
    const actions: Array<{ harness: WorkbenchHarness; scopes: readonly string[] }> = [];
    let refreshWorkbenchPromptFiles = false;
    let reloadOrchestratorLogic = false;
    for (const adapter of this.adapters) {
      if (adapter.reload.kind !== "scoped") continue;
      const selected = adapter.reload.scopes.filter(({ scope }) => requested.delete(scope));
      if (!selected.length) continue;
      refreshWorkbenchPromptFiles ||= selected.some((scope) => scope.refreshWorkbenchPromptFiles);
      reloadOrchestratorLogic ||= selected.some((scope) => scope.reloadOrchestratorLogic);
      actions.push({ harness: adapter.id, scopes: selected.map(({ scope }) => scope) });
    }
    const unknown = requested.values().next().value as string | undefined;
    if (unknown) throw new Error(`Unknown Workbench provider reload scope: ${unknown}.`);
    return { actions, refreshWorkbenchPromptFiles, reloadOrchestratorLogic };
  }

  async executeReloadPlan(plan: WorkbenchHarnessReloadPlan) {
    const currentPlan = this.planReload(plan.actions.flatMap(({ scopes }) => scopes));
    if (
      currentPlan.refreshWorkbenchPromptFiles !== plan.refreshWorkbenchPromptFiles
      || currentPlan.reloadOrchestratorLogic !== plan.reloadOrchestratorLogic
    ) {
      throw new Error("Workbench harness reload preparation changed during the feature reload.");
    }
    for (const action of currentPlan.actions) {
      const adapter = this.getAdapter(action.harness);
      if (adapter.reload.kind !== "scoped") throw new Error(`Workbench harness ${action.harness} no longer supports reload actions.`);
      const registeredScopes = new Set(adapter.reload.scopes.map(({ scope }) => scope));
      for (const scope of action.scopes) {
        if (!registeredScopes.has(scope) || this.reloadScopes.get(scope) !== action.harness) {
          throw new Error(`Workbench reload scope ${scope} is no longer registered by ${action.harness}.`);
        }
      }
      await adapter.reload.execute(action.scopes);
    }
  }

  private getAdapter(harness: WorkbenchHarness) {
    const adapter = this.adaptersById.get(harness);
    if (!adapter) throw new Error(`Unknown Workbench harness: ${harness}.`);
    return adapter;
  }
}
