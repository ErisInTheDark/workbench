/*
 * Exports:
 * - WorkbenchOrchestratorHealthClientOptions: injectable socket and timer edge for runner tests. Keywords: WebSocket, deadline, test.
 * - default WorkbenchOrchestratorHealthClient: perform one bounded typed health round trip over the existing shared socket client. Keywords: runner, health, RPC.
 */
import { CodexAppServerClient } from "../shared/codex/app-server-client.ts";
import { isCodexJsonRpcFailure, type CodexJsonRpcResponse } from "../shared/codex/protocol.ts";
import {
  WORKBENCH_ORCHESTRATOR_HEALTH_METHOD,
  WorkbenchOrchestratorHealthResultSchema,
} from "../shared/workbench/orchestrator-health.ts";

interface HealthSocketClient {
  connectSocket(url: string): Promise<void>;
  dispose(): void;
  sendRequest(
    message: { method: string; params: object },
    options: { socketOnly: true },
  ): Promise<CodexJsonRpcResponse<unknown>>;
}

type Timer = ReturnType<typeof globalThis.setTimeout>;

export interface WorkbenchOrchestratorHealthClientOptions {
  clearTimeout?: (timer: Timer) => void;
  createClient?: () => HealthSocketClient;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
}

export default class WorkbenchOrchestratorHealthClient {
  private readonly cancelTimer: (timer: Timer) => void;
  private readonly createClient: () => HealthSocketClient;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => Timer;

  constructor(options: WorkbenchOrchestratorHealthClientOptions = {}) {
    this.cancelTimer = options.clearTimeout ?? globalThis.clearTimeout;
    this.createClient = options.createClient ?? (() => new CodexAppServerClient());
    this.scheduleTimer = options.setTimeout ?? globalThis.setTimeout;
  }

  async probe(url: string, timeoutMs: number, signal?: AbortSignal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Orchestrator health probe timeout must be positive.");
    const client = this.createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let removeAbort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("Orchestrator health probe cancelled."));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal?.removeEventListener("abort", abort);
      timer = this.scheduleTimer(
        () => reject(new Error(`Orchestrator WebSocket health probe exceeded ${timeoutMs}ms.`)),
        timeoutMs,
      );
    });
    try {
      const response = await Promise.race([
        this.request(client, url),
        interrupted,
      ]);
      if (isCodexJsonRpcFailure(response)) throw new Error(response.error.message);
      const parsed = WorkbenchOrchestratorHealthResultSchema.safeParse(response.result);
      if (!parsed.success) throw new Error("Orchestrator WebSocket health response was invalid.");
      return parsed.data;
    } finally {
      if (timer !== null) this.cancelTimer(timer);
      removeAbort();
      client.dispose();
    }
  }

  private async request(client: HealthSocketClient, url: string): Promise<CodexJsonRpcResponse<unknown>> {
    await client.connectSocket(url);
    return await client.sendRequest({
      method: WORKBENCH_ORCHESTRATOR_HEALTH_METHOD,
      params: {},
    }, { socketOnly: true });
  }
}
