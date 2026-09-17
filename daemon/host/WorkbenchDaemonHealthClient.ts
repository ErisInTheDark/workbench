/*
 * Exports:
 * - WorkbenchDaemonHealthClientOptions: injectable socket and timer edge for runner tests.
 * - default WorkbenchDaemonHealthClient: perform one bounded typed health round trip over the existing shared socket client.
 */
import WorkbenchSocketClient from "../../shared/workbench/WorkbenchSocketClient.ts";
import { isWorkbenchRpcFailure, type WorkbenchRpcResponse } from "../../shared/workbench/workbench-rpc.ts";
import {
  WORKBENCH_DAEMON_HEALTH_METHOD,
  WorkbenchDaemonHealthResultSchema,
} from "../../shared/workbench/daemon-health.ts";

interface HealthSocketClient {
  connectSocket(url: string): Promise<void>;
  dispose(): void;
  sendRequest(
    message: { method: string; params: object },
  ): Promise<WorkbenchRpcResponse<unknown>>;
}

type Timer = ReturnType<typeof globalThis.setTimeout>;

export interface WorkbenchDaemonHealthClientOptions {
  clearTimeout?: (timer: Timer) => void;
  createClient?: () => HealthSocketClient;
  setTimeout?: (callback: () => void, delayMs: number) => Timer;
}

export default class WorkbenchDaemonHealthClient {
  private readonly cancelTimer: (timer: Timer) => void;
  private readonly createClient: () => HealthSocketClient;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => Timer;

  constructor(options: WorkbenchDaemonHealthClientOptions = {}) {
    this.cancelTimer = options.clearTimeout ?? globalThis.clearTimeout;
    this.createClient = options.createClient ?? (() => new WorkbenchSocketClient());
    this.scheduleTimer = options.setTimeout ?? globalThis.setTimeout;
  }

  async probe(url: string, timeoutMs: number, signal?: AbortSignal) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Daemon health probe timeout must be positive.");
    const client = this.createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let removeAbort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("Daemon health probe cancelled."));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal?.removeEventListener("abort", abort);
      timer = this.scheduleTimer(
        () => reject(new Error(`Daemon WebSocket health probe exceeded ${timeoutMs}ms.`)),
        timeoutMs,
      );
    });
    try {
      const response = await Promise.race([
        this.request(client, url),
        interrupted,
      ]);
      if (isWorkbenchRpcFailure(response)) throw new Error(response.error.message);
      const parsed = WorkbenchDaemonHealthResultSchema.safeParse(response.result);
      if (!parsed.success) throw new Error("Daemon WebSocket health response was invalid.");
      return parsed.data;
    } finally {
      if (timer !== null) this.cancelTimer(timer);
      removeAbort();
      client.dispose();
    }
  }

  private async request(client: HealthSocketClient, url: string): Promise<WorkbenchRpcResponse<unknown>> {
    await client.connectSocket(url);
    return await client.sendRequest({
      method: WORKBENCH_DAEMON_HEALTH_METHOD,
      params: {},
    });
  }
}
