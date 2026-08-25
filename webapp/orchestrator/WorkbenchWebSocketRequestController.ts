/*
 * Exports:
 * - WorkbenchWebSocketPendingRequestState/WorkbenchWebSocketRequestControllerState: handoff state for requests awaiting browser responses. Keywords: websocket, request, handoff, timer.
 * - WorkbenchWebSocketRequestControllerOptions: injected routing, clock, scheduler, and log ports. Keywords: websocket, dependency injection, diagnostics.
 * - default WorkbenchWebSocketRequestController: own browser WebSocket routing, pending warnings, response timing, send completion, and disconnect cleanup. Keywords: websocket, json-rpc, latency, lifecycle.
 */
import type { WorkbenchHarness } from "../lib/types";
import type { BridgeClient, JsonRpcRequest } from "./bridge-types";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";

const WORKBENCH_HARNESS_FIELD = "workbenchHarness";
const DEFAULT_PENDING_THRESHOLD_MS = 2_000;
const PENDING_WARNING_INTERVAL_MS = 2_000;
const PENDING_THRESHOLD_OVERRIDES = new Map<string, number>([
  ["initialize", 10_000],
  ["thread/compact/start", 30_000],
]);
const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RESET = "\u001b[0m";

type RequestId = number | string | null;
type Timer = ReturnType<typeof setTimeout>;
type CompletionOutcome = "closed" | "error" | "ok" | "replaced" | "send-error";

export interface WorkbenchWebSocketPendingRequestState {
  client: BridgeClient;
  id: RequestId;
  inBytes: number;
  method: string;
  nextWarningAt: number;
  startedAt: number;
}

export interface WorkbenchWebSocketRequestControllerState {
  pending: WorkbenchWebSocketPendingRequestState[];
}

interface PendingRequest extends WorkbenchWebSocketPendingRequestState {
  timer: Timer | null;
}

export interface WorkbenchWebSocketRequestControllerOptions {
  clearTimeout?: (timer: Timer) => void;
  harnesses: Pick<WorkbenchHarnessController, "handleBrowserMessage" | "resolveHarness">;
  initialState?: WorkbenchWebSocketRequestControllerState;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
  threadState: Pick<WorkbenchThreadStateController, "acceptIntent" | "disconnect" | "handleRequest">;
  writeLine?: (line: string) => void;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatBytes(value: number) {
  if (value < 1_024) return `${Math.max(0, Math.round(value))}B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)}KB`;
  return `${(value / 1_024 / 1_024).toFixed(1)}MB`;
}

function formatDuration(value: number) {
  const duration = Math.max(0, value);
  return duration < 1_000 ? `${Math.round(duration)}ms` : `${(duration / 1_000).toFixed(1)}s`;
}

function completionToken(outcome: CompletionOutcome) {
  const color = outcome === "ok" ? ANSI_GREEN : ANSI_RED;
  return `${color}${outcome}${ANSI_RESET}`;
}

function pendingToken() {
  return `${ANSI_YELLOW}pending${ANSI_RESET}`;
}

function methodLabel(harness: WorkbenchHarness | "unknown" | "workbench", method: string) {
  return harness === "workbench" && method.startsWith("workbench/")
    ? `workbench:${method.slice("workbench/".length)}`
    : `${harness}:${method}`;
}

function readResponseId(message: unknown): RequestId | undefined {
  const record = asRecord(message);
  const id = record?.id;
  if (id === null || typeof id === "number" || typeof id === "string") return id as RequestId;
  return undefined;
}

function responseIsError(message: unknown) {
  const record = asRecord(message);
  return Boolean(record && "error" in record && record.error !== undefined);
}

export default class WorkbenchWebSocketRequestController {
  private detached = false;
  private readonly harnesses: WorkbenchWebSocketRequestControllerOptions["harnesses"];
  private readonly now: NonNullable<WorkbenchWebSocketRequestControllerOptions["now"]>;
  private readonly pending = new Map<BridgeClient, Map<RequestId, PendingRequest>>();
  private readonly schedule: NonNullable<WorkbenchWebSocketRequestControllerOptions["setTimeout"]>;
  private readonly cancel: NonNullable<WorkbenchWebSocketRequestControllerOptions["clearTimeout"]>;
  private readonly threadState: WorkbenchWebSocketRequestControllerOptions["threadState"];
  private readonly writeLine: NonNullable<WorkbenchWebSocketRequestControllerOptions["writeLine"]>;

  constructor({
    clearTimeout: cancel = clearTimeout,
    harnesses,
    initialState,
    now = Date.now,
    setTimeout: schedule = setTimeout,
    threadState,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  }: WorkbenchWebSocketRequestControllerOptions) {
    this.cancel = cancel;
    this.harnesses = harnesses;
    this.now = now;
    this.schedule = schedule;
    this.threadState = threadState;
    this.writeLine = writeLine;
    for (const state of initialState?.pending ?? []) this.restorePending(state);
  }

  async handleMessage(client: BridgeClient, connectionId: string, data: Buffer, hardReloadPending: boolean) {
    this.assertActive();
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(data.toString()) as JsonRpcRequest;
    } catch {
      client.close(1003, "Invalid JSON.");
      return;
    }
    const method = typeof message.method === "string" && message.method ? message.method : null;
    if (!method) throw new Error("Workbench WebSocket message is missing a method.");

    const requestId = "id" in message ? message.id : undefined;
    const isRequest = requestId === null || typeof requestId === "number" || typeof requestId === "string";
    const workbenchRequest = method.startsWith("workbench/thread-state/");
    let harness: WorkbenchHarness | "unknown" | "workbench" = workbenchRequest ? "workbench" : "unknown";
    if (!workbenchRequest) {
      try {
        harness = this.harnesses.resolveHarness(message[WORKBENCH_HARNESS_FIELD], { defaultToCodex: true });
      } catch (error) {
        if (!isRequest) throw error;
        this.beginRequest(client, requestId, data.length, methodLabel("unknown", method), method);
        await this.sendJsonToClient(client, {
          id: requestId,
          error: { code: -32000, message: error instanceof Error ? error.message : "Harness bridge request failed." },
        });
        return;
      }
    }
    if (isRequest) this.beginRequest(client, requestId, data.length, methodLabel(harness, method), method);

    if (hardReloadPending) {
      if (isRequest) {
        await this.sendJsonToClient(client, {
          id: requestId,
          error: { code: -32000, message: "The orchestrator is hard reloading; reconnect shortly." },
        });
      }
      return;
    }

    if (workbenchRequest && isRequest) {
      if (method === "workbench/thread-state/accepted") {
        const params = asRecord(message.params) ?? {};
        try {
          const acceptedHarness = this.harnesses.resolveHarness(params.harness);
          const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
          const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
          const turnId = typeof params.turnId === "string" ? params.turnId.trim() : "";
          if (!projectId || !threadId || !turnId) throw new Error("Invalid accepted-intent lifecycle evidence.");
          const result = await this.threadState.acceptIntent(connectionId, { harness: acceptedHarness, projectId, threadId, turnId });
          await this.sendJsonToClient(client, { id: requestId, result });
        } catch (error) {
          await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : "Accepted-intent publication failed." } });
        }
        return;
      }
      const result = await this.threadState.handleRequest(connectionId, { method, ...(asRecord(message.params) ?? {}) });
      await this.sendJsonToClient(client, { id: requestId, ...result });
      return;
    }

    const strippedMessage = { ...message };
    delete strippedMessage[WORKBENCH_HARNESS_FIELD];
    try {
      await this.harnesses.handleBrowserMessage(harness, strippedMessage, client);
    } catch (error) {
      if (!isRequest) throw error;
      await this.sendJsonToClient(client, { id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : "Harness bridge request failed." } });
    }
  }

  async sendJsonToClient(client: BridgeClient, message: unknown) {
    this.assertActive();
    const responseId = readResponseId(message);
    const pending = responseId === undefined ? null : this.pending.get(client)?.get(responseId) ?? null;
    const serializeStartedAt = this.now();
    let serialized: string;
    try {
      const value = JSON.stringify(message);
      if (typeof value !== "string") throw new Error("Workbench WebSocket message did not serialize to JSON.");
      serialized = value;
    } catch (error) {
      if (pending) this.complete(pending, "error", serializeStartedAt - pending.startedAt, this.now() - serializeStartedAt, 0, 0);
      throw error;
    }
    const serializedAt = this.now();
    const processMs = pending ? serializeStartedAt - pending.startedAt : 0;
    const jsonMs = serializedAt - serializeStartedAt;
    if (client.readyState !== client.OPEN) {
      if (pending) this.complete(pending, "closed", processMs, jsonMs, 0, Buffer.byteLength(serialized));
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const sentAt = this.now();
      const finish = (error?: Error) => {
        if (pending) {
          this.complete(
            pending,
            error ? "send-error" : responseIsError(message) ? "error" : "ok",
            processMs,
            jsonMs,
            this.now() - sentAt,
            Buffer.byteLength(serialized),
          );
        }
        if (error) reject(error);
        else resolve();
      };
      try {
        client.send(serialized, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async disconnect(client: BridgeClient, connectionId: string) {
    this.assertActive();
    const requests = [...(this.pending.get(client)?.values() ?? [])];
    for (const request of requests) this.complete(request, "closed", this.now() - request.startedAt, 0, 0, 0);
    await this.threadState.disconnect(connectionId);
  }

  detachForReload(): WorkbenchWebSocketRequestControllerState {
    this.assertActive();
    this.detached = true;
    const pending = [...this.pending.values()].flatMap((requests) => [...requests.values()].map((request) => {
      if (request.timer) this.cancel(request.timer);
      const { timer: _timer, ...state } = request;
      return state;
    }));
    this.pending.clear();
    return { pending };
  }

  dispose() {
    if (this.detached) return;
    this.detached = true;
    for (const requests of this.pending.values()) {
      for (const request of requests.values()) if (request.timer) this.cancel(request.timer);
    }
    this.pending.clear();
  }

  private beginRequest(client: BridgeClient, id: RequestId, inBytes: number, label: string, method: string) {
    let requests = this.pending.get(client);
    if (!requests) {
      requests = new Map();
      this.pending.set(client, requests);
    }
    const existing = requests.get(id);
    if (existing) this.complete(existing, "replaced", this.now() - existing.startedAt, 0, 0, 0);
    const startedAt = this.now();
    const request: PendingRequest = {
      client,
      id,
      inBytes,
      method: label,
      nextWarningAt: startedAt + (PENDING_THRESHOLD_OVERRIDES.get(method) ?? DEFAULT_PENDING_THRESHOLD_MS),
      startedAt,
      timer: null,
    };
    requests.set(id, request);
    this.scheduleWarning(request);
  }

  private restorePending(state: WorkbenchWebSocketPendingRequestState) {
    let requests = this.pending.get(state.client);
    if (!requests) {
      requests = new Map();
      this.pending.set(state.client, requests);
    }
    const request = { ...state, timer: null } satisfies PendingRequest;
    requests.set(state.id, request);
    this.scheduleWarning(request);
  }

  private scheduleWarning(request: PendingRequest) {
    request.timer = this.schedule(() => {
      request.timer = null;
      if (this.detached || this.pending.get(request.client)?.get(request.id) !== request) return;
      const now = this.now();
      this.writeLine(` WS ${request.method} ${pendingToken()} after ${formatDuration(now - request.startedAt)}`);
      request.nextWarningAt = now + PENDING_WARNING_INTERVAL_MS;
      this.scheduleWarning(request);
    }, Math.max(0, request.nextWarningAt - this.now()));
  }

  private complete(request: PendingRequest, outcome: CompletionOutcome, processMs: number, jsonMs: number, sendMs: number, outBytes: number) {
    if (request.timer) this.cancel(request.timer);
    const requests = this.pending.get(request.client);
    if (requests?.get(request.id) === request) requests.delete(request.id);
    if (requests?.size === 0) this.pending.delete(request.client);
    const totalMs = this.now() - request.startedAt;
    this.writeLine(` WS ${request.method} ${completionToken(outcome)} in ${formatDuration(totalMs)} (process: ${formatDuration(processMs)}, json: ${formatDuration(jsonMs)}, send: ${formatDuration(sendMs)}, in: ${formatBytes(request.inBytes)}, out: ${formatBytes(outBytes)})`);
  }

  private assertActive() {
    if (this.detached) throw new Error("Workbench WebSocket request controller is detached.");
  }
}
