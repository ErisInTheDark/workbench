/*
 * Exports:
 * - CodexStdioBridge: manage the shared Codex app-server stdio child and translate websocket requests and notifications against it. Keywords: codex, stdio, websocket, bridge.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { BridgeClient, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import {
    createSpawnOptions,
    getSpawnDescriptor,
    killProcessTree,
    log,
    logError,
    pipeChildStream,
} from "./process-helpers";

type PendingClientResponse = {
  client: BridgeClient;
  clientRequestId: number | string;
  internal: false;
  method: string | null;
};

type PendingInternalResponse = {
  internal: true;
  reject: (reason?: unknown) => void;
  resolve: (value: JsonRpcResponse) => void;
};

type PendingResponse = PendingClientResponse | PendingInternalResponse;

function isPendingInternalResponse(pending: PendingResponse): pending is PendingInternalResponse {
  return pending.internal === true;
}

type CodexStdioBridgeOptions = {
  bridgeUrl: string;
  onFatalExit: (reason: string) => void;
  onNotification: (notification: JsonRpcNotification) => void;
  projectRoot: string;
  sendToClient: (client: BridgeClient, message: unknown) => void;
};

function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  return !!message
    && typeof message === "object"
    && "id" in message
    && ("result" in message || "error" in message);
}

function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  return !!message
    && typeof message === "object"
    && "method" in message
    && "params" in message
    && !("id" in message);
}

export class CodexStdioBridge {
  private readonly bridgeUrl: string;
  private readonly onFatalExit: CodexStdioBridgeOptions["onFatalExit"];
  private readonly onNotification: CodexStdioBridgeOptions["onNotification"];
  private readonly projectRoot: string;
  private readonly sendToClient: CodexStdioBridgeOptions["sendToClient"];
  private codexProcess: ChildProcess | null = null;
  private initializeResult: unknown = null;
  private nextRequestId = 1;
  private readonly pendingResponses = new Map<number, PendingResponse>();
  private upstreamInitialized = false;
  private upstreamInitializePromise: Promise<void> | null = null;

  constructor({ bridgeUrl, onFatalExit, onNotification, projectRoot, sendToClient }: CodexStdioBridgeOptions) {
    this.bridgeUrl = bridgeUrl;
    this.onFatalExit = onFatalExit;
    this.onNotification = onNotification;
    this.projectRoot = projectRoot;
    this.sendToClient = sendToClient;
  }

  getInitializeResult() {
    return this.initializeResult;
  }

  getListenDescriptor() {
    const parsedUrl = new URL(this.bridgeUrl);
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
      throw new Error(`Codex bridge URL must use ws:// or wss://, received ${this.bridgeUrl}`);
    }

    return {
      host: parsedUrl.hostname || "127.0.0.1",
      port: Number(parsedUrl.port || (parsedUrl.protocol === "wss:" ? 443 : 80)),
    };
  }

  stop() {
    this.pendingResponses.clear();
    this.upstreamInitialized = false;
    this.upstreamInitializePromise = null;

    if (this.codexProcess && !this.codexProcess.killed) {
      killProcessTree(this.codexProcess.pid);
      this.codexProcess = null;
    }
  }

  async ensureInitialized(initializeMessage: JsonRpcRequest) {
    if (this.upstreamInitialized) {
      return;
    }

    if (this.upstreamInitializePromise) {
      await this.upstreamInitializePromise;
      return;
    }

    this.upstreamInitializePromise = (async () => {
      const response = await this.request(initializeMessage, { internal: true });
      if (response.error) {
        throw new Error(response.error.message);
      }

      this.initializeResult = response.result;
      this.send({ method: "initialized" });
      this.upstreamInitialized = true;
    })();

    try {
      await this.upstreamInitializePromise;
    } finally {
      this.upstreamInitializePromise = null;
    }
  }

  forwardRequest(message: JsonRpcRequest, client: BridgeClient, clientRequestId: number | string) {
    void this.request(message, { client, clientRequestId });
  }

  forwardNotification(message: JsonRpcRequest) {
    this.send(message);
  }

  private createStdioChild() {
    const spawnDescriptor = getSpawnDescriptor({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
    });

    return spawn(spawnDescriptor.command, spawnDescriptor.args, {
      ...createSpawnOptions(this.projectRoot, {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      }, true),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private ensureProcess() {
    if (this.codexProcess && !this.codexProcess.killed) {
      return this.codexProcess;
    }

    this.codexProcess = this.createStdioChild();
    this.initializeResult = null;
    this.nextRequestId = 1;
    this.pendingResponses.clear();
    this.upstreamInitialized = false;
    this.upstreamInitializePromise = null;
    this.bindStdout(this.codexProcess);
    pipeChildStream("codex-stdio", this.codexProcess.stderr, (chunk) => process.stderr.write(chunk));

    this.codexProcess.once("error", (error) => {
      logError("codex-stdio", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
      this.onFatalExit("Codex app-server failed to start.");
    });

    this.codexProcess.once("exit", (code, signal) => {
      log("codex-stdio", `exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.codexProcess = null;
      this.initializeResult = null;
      this.pendingResponses.clear();
      this.upstreamInitialized = false;
      this.upstreamInitializePromise = null;
      this.onFatalExit("Codex app-server exited.");
    });

    log("codex-bridge", "started shared stdio app-server");
    return this.codexProcess;
  }

  private nextUpstreamRequestId() {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return requestId;
  }

  private send(message: unknown) {
    this.ensureProcess();
    if (!this.codexProcess?.stdin.writable) {
      throw new Error("Codex app-server bridge is not running.");
    }

    this.codexProcess.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(
    message: JsonRpcRequest,
    {
      client,
      clientRequestId,
      internal = false,
    }: {
      client?: BridgeClient;
      clientRequestId?: number | string;
      internal?: boolean;
    },
  ) {
    this.ensureProcess();

    const upstreamRequestId = this.nextUpstreamRequestId();
    const upstreamMessage = {
      ...message,
      id: upstreamRequestId,
    };

    if (internal) {
      const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
        this.pendingResponses.set(upstreamRequestId, {
          internal: true,
          reject,
          resolve,
        });
      });
      this.send(upstreamMessage);
      return responsePromise;
    }

    if (!client || clientRequestId === undefined) {
      throw new Error("Bridge client and client request id are required for external requests.");
    }

    this.pendingResponses.set(upstreamRequestId, {
      client,
      clientRequestId,
      internal: false,
      method: typeof message.method === "string" ? message.method : null,
    });
    this.send(upstreamMessage);
    return null;
  }

  private bindStdout(codexProcess: ChildProcess) {
    let bufferedOutput = "";

    codexProcess.stdout?.on("data", (chunk: Buffer) => {
      bufferedOutput += chunk.toString("utf8");
      const lines = bufferedOutput.split(/\r?\n/u);
      bufferedOutput = lines.pop() ?? "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          continue;
        }

        try {
          this.handleUpstreamMessage(JSON.parse(trimmedLine) as unknown);
        } catch (error) {
          logError("codex-bridge", `invalid upstream JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }

  private handleUpstreamMessage(message: unknown) {
    if (isJsonRpcResponse(message)) {
      const pending = this.pendingResponses.get(Number(message.id));
      if (!pending) {
        return;
      }

      this.pendingResponses.delete(Number(message.id));
      if (isPendingInternalResponse(pending)) {
        pending.resolve(message);
        return;
      }

      this.sendToClient(pending.client, {
        ...message,
        id: pending.clientRequestId,
      });
      return;
    }

    if (isJsonRpcNotification(message)) {
      this.onNotification(message);
    }
  }
}