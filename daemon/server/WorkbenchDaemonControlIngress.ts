/*
 * Exports:
 * - WorkbenchDaemonControlIngressOptions: process-owned control and feature-dispatch ports.
 * - default WorkbenchDaemonControlIngress: route control requests before feature graph admission.
 */
import { WORKBENCH_DAEMON_HEALTH_METHOD, WorkbenchDaemonHealthParamsSchema } from "workbench-shared/workbench/daemon-health";
import { DaemonReloadRequestSchema, WORKBENCH_RELOAD_METHOD } from "workbench-shared/workbench/daemon-reload";
import type { BridgeClient, JsonRpcResponse } from "./bridge-types";
import type WorkbenchDaemonReloadController from "./WorkbenchDaemonReloadController";

export interface WorkbenchDaemonControlIngressOptions {
  dispatch(client: BridgeClient, connectionId: string, data: Buffer): Promise<void>;
  getReloadController(): Pick<WorkbenchDaemonReloadController, "admitUserReload">;
  logError(message: string): void;
  log?(message: string): void;
}

export default class WorkbenchDaemonControlIngress {
  constructor(private readonly options: WorkbenchDaemonControlIngressOptions) {}

  async handle(client: BridgeClient, connectionId: string, data: Buffer) {
    let message: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) message = parsed as Record<string, unknown>;
    } catch {
      // The feature dispatcher owns invalid JSON handling for ordinary traffic.
    }
    const rawId = message?.id;
    const id = rawId === null ? null : typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined;
    const request = id !== undefined;
    if (request && message?.method === WORKBENCH_DAEMON_HEALTH_METHOD) {
      const parsed = WorkbenchDaemonHealthParamsSchema.safeParse(message.params ?? {});
      await this.send(client, parsed.success
        ? { id, result: { ok: true } }
        : { id, error: { code: -32000, message: "Invalid Workbench daemon health request." } });
      return;
    }
    if (request && message?.method === WORKBENCH_RELOAD_METHOD) {
      const parsed = DaemonReloadRequestSchema.safeParse(message.params);
      if (!parsed.success) {
        await this.send(client, { id, error: { code: -32000, message: "Invalid Workbench reload request." } });
        return;
      }
      let admission;
      try {
        admission = this.options.getReloadController().admitUserReload(parsed.data);
      } catch (error) {
        await this.send(client, { id, error: { code: -32000, message: this.describeError(error) } });
        return;
      }
      try {
        await this.send(client, { id, result: admission.response });
      } catch (error) {
        admission.cancel();
        throw error;
      }
      this.options.log?.(`WS wb:daemon/reload admitted (${admission.response.requestedScopes.join(", ")})`);
      void Promise.resolve().then(() => admission.start()).catch((error: unknown) => {
        this.options.logError(this.describeError(error));
      });
      return;
    }
    try {
      await this.options.dispatch(client, connectionId, data);
    } catch (error) {
      this.options.logError(this.describeError(error));
      if (!request) throw error;
      await this.send(client, { id, error: { code: -32000, message: this.describeError(error) } });
    }
  }

  private async send(client: BridgeClient, response: JsonRpcResponse) {
    if (client.readyState !== client.OPEN) throw new Error("The control response socket is closed.");
    await new Promise<void>((resolve, reject) => {
      client.send(JSON.stringify(response), (error) => error ? reject(error) : resolve());
    });
  }

  private describeError(error: unknown) {
    return error instanceof Error ? error.message.slice(0, 2_000) : "Daemon request failed.";
  }
}
