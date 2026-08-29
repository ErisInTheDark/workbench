/*
 * Exports:
 * - WorkbenchHarnessRuntimePort: stable bridge operations supplied to reloadable harness registrations. Keywords: harness, bridge, port, lifecycle.
 * - WorkbenchHarnessAdapter: exhaustive provider capability registration. Keywords: harness, capability, recovery.
 * - default WorkbenchHarnessController: validate registrations and own browser, server, Browse, and recovery routing. Keywords: harness, routing, recovery.
 */
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type { WorkbenchHarness } from "../lib/types";
import type { BridgeClient, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { WorkbenchTurnRecoveryPort } from "./WorkbenchTurnRecoveryController";

export interface WorkbenchHarnessRuntimePort {
  handleBrowserMessage(message: JsonRpcRequest, client: BridgeClient): Promise<void>;
  request(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  readThread(threadId: string): Promise<ThreadReadResponse>;
  steerTurn(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<string | null>;
  recoverInterruptedTurn?: WorkbenchTurnRecoveryPort;
}

type WorkbenchHarnessRecoveryCapability =
  | { kind: "none" }
  | {
      observeNotification(notification: JsonRpcNotification): void;
      observeRequest(request: JsonRpcRequest): void;
      kind: "observe";
    }
  | {
      kind: "turn";
      observeNotification(notification: JsonRpcNotification): void;
      observeRequest(request: JsonRpcRequest): void;
      recoverAvailable?(): Promise<void>;
      resumeThread(threadId: string): Promise<void>;
    };

export interface WorkbenchHarnessAdapter {
  browse: Pick<WorkbenchHarnessRuntimePort, "readThread" | "steerTurn">;
  browser: Pick<WorkbenchHarnessRuntimePort, "handleBrowserMessage">;
  id: WorkbenchHarness;
  internal: Pick<WorkbenchHarnessRuntimePort, "request">;
  recovery: WorkbenchHarnessRecoveryCapability;
  serverMethods: readonly string[];
}

export interface WorkbenchHarnessControllerOptions {
  admitTurnStart?: () => void;
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
  private readonly admitTurnStart: () => void;

  constructor(adapters: readonly WorkbenchHarnessAdapter[], options: WorkbenchHarnessControllerOptions = {}) {
    if (!adapters.length) throw new Error("At least one Workbench harness adapter is required.");
    const adaptersById = new Map<WorkbenchHarness, WorkbenchHarnessAdapter>();
    for (const adapter of adapters) {
      if (adaptersById.has(adapter.id)) throw new Error(`Workbench harness ${adapter.id} is registered more than once.`);
      requireNonEmptyUniqueValues(adapter.serverMethods, `Workbench harness ${adapter.id} server methods`);
      adaptersById.set(adapter.id, adapter);
    }
    if (!adaptersById.has("codex")) throw new Error("The default Codex harness adapter is required.");
    this.adapters = [...adapters];
    this.adaptersById = adaptersById;
    this.admitTurnStart = options.admitTurnStart ?? (() => undefined);
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
    if (message.method === "turn/start") this.admitTurnStart();
    if (adapter.recovery.kind !== "none" && "id" in message) adapter.recovery.observeRequest(message);
    await adapter.browser.handleBrowserMessage(message, client);
  }

  async request(harness: WorkbenchHarness, request: JsonRpcRequest) {
    const adapter = this.getAdapter(harness);
    if (request.method === "turn/start") this.admitTurnStart();
    if (adapter.recovery.kind !== "none") adapter.recovery.observeRequest(request);
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
    if (recovery.kind !== "none") recovery.observeNotification(notification);
  }

  async recoverAvailable(harness: WorkbenchHarness) {
    const recovery = this.getAdapter(harness).recovery;
    if (recovery.kind === "turn") await recovery.recoverAvailable?.();
  }

  async resumeThread(harness: WorkbenchHarness, threadId: string) {
    const recovery = this.getAdapter(harness).recovery;
    if (recovery.kind !== "turn") throw new Error(`Manual thread resume is unavailable for ${harness} threads.`);
    await recovery.resumeThread(threadId);
  }

  private getAdapter(harness: WorkbenchHarness) {
    const adapter = this.adaptersById.get(harness);
    if (!adapter) throw new Error(`Unknown Workbench harness: ${harness}.`);
    return adapter;
  }
}
