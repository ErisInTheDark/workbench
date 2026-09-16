/*
 * Exports:
 * - CodexAppServerClient: retained native handshake for unmigrated internal Codex callers.
 * - WorkbenchClientNotification: compatibility notification type.
 */
import WorkbenchSocketClient from "../workbench/WorkbenchSocketClient.ts";
import {
  createInitializeCapabilities, createInitializeRequest, createInitializedNotification, isCodexJsonRpcFailure,
  type CodexInitializeResponse, type CodexJsonRpcResponse,
} from "./protocol.ts";
import { getCodexAppServerUrl } from "./config.ts";
export type { WorkbenchClientNotification } from "../workbench/WorkbenchSocketClient.ts";

export class CodexAppServerClient {
  private readonly socket: WorkbenchSocketClient;
  private initialized = false;
  private initialization: Promise<void> | null = null;

  constructor(options: ConstructorParameters<typeof WorkbenchSocketClient>[0] = {}) {
    this.socket = new WorkbenchSocketClient(options);
    this.onConnectionClose(() => { this.initialized = false; });
  }

  async connect(url = getCodexAppServerUrl()) {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    const initialization = this.initialize(url);
    this.initialization = initialization;
    try { await initialization; }
    finally { if (this.initialization === initialization) this.initialization = null; }
  }

  private async initialize(url: string) {
    await this.connectSocket(url);
    const request = createInitializeRequest(0, { capabilities: createInitializeCapabilities({ experimentalApi: true }) });
    const response = await this.socket.sendRequest<CodexInitializeResponse>({ ...request, id: 0 });
    if (isCodexJsonRpcFailure(response)) throw new Error(response.error.message);
    this.send(createInitializedNotification());
    this.initialized = true;
  }

  async sendRequest<TResponse = unknown>(
    message: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
    options: { socketOnly?: boolean } = {},
  ): Promise<CodexJsonRpcResponse<TResponse>> {
    if (!options.socketOnly && !this.initialized && message.method !== "initialize") await this.connect();
    return this.socket.sendRequest<TResponse>(message, options);
  }

  connectSocket = (url?: string) => this.socket.connectSocket(url);
  send = (message: object) => this.socket.send(message);
  close = (code?: number, reason?: string) => this.socket.close(code, reason);
  dispose = () => this.socket.dispose();
  onNotification = (listener: Parameters<WorkbenchSocketClient["onNotification"]>[0]) => this.socket.onNotification(listener);
  onWorkbenchNotification = (listener: Parameters<WorkbenchSocketClient["onWorkbenchNotification"]>[0]) => this.socket.onWorkbenchNotification(listener);
  onConnectionClose = (listener: () => void) => this.socket.onConnectionClose(listener);
  onReconnect = (listener: () => void) => this.socket.onReconnect(listener);
}
