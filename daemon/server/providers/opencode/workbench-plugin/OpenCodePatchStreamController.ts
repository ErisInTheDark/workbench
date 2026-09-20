/*
 * Exports:
 * - default OpenCodePatchStreamController: observe managed model transports without changing their bytes or execution lifecycle.
 */
import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";
import type { SessionHttpResponse, SessionWebSocketReceive, SessionWebSocketSend } from "@opencode/plugin/promise/session";
import type { OpenCodePatchObservation } from "../opencode-workbench-rpc";
import OpenCodePatchPreview from "./open-code-patch-preview";
import OpenCodeToolStream from "./open-code-tool-stream";

type Preview = Extract<OpenCodePatchObservation, { kind: "preview" }>;
interface RequestState {
  sessionID: string;
  requestID: string;
  disabled: boolean;
  decoder: OpenCodeToolStream;
  tools: Map<string, { tool: Preview["tool"]; parser: OpenCodePatchPreview }>;
  pending: Map<string, Preview>;
}

export default class OpenCodePatchStreamController {
  private readonly active = new Set<RequestState>();
  private readonly sockets = new Map<string, RequestState>();
  private disposed = false;

  constructor(private readonly options: {
    isManagedSession(sessionID: string): Promise<boolean>;
    emit(observation: OpenCodePatchObservation): Promise<void>;
    warn(message: string): void;
  }) {}

  async httpResponse(input: SessionHttpResponse) {
    if (this.disposed || input.kind !== "primary" || !input.response.ok || !input.response.body
      || !input.response.headers.get("content-type")?.includes("text/event-stream")) return;
    const state = await this.begin(input.sessionID);
    if (!state) return;
    const reader = input.response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createParser({
      maxBufferSize: 8 * 1024 * 1024,
      onEvent: event => {
        if (event.data !== "[DONE]") state.decoder.accept(JSON.parse(event.data));
      },
      onError: error => {
        if (error.type === "max-buffer-size-exceeded") throw new Error("Preview SSE capacity exceeded.");
      },
    });
    const owner = this;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            owner.active.delete(state);
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!state.disabled && !owner.disposed) {
            try {
              parser.feed(decoder.decode(chunk.value, { stream: true }));
              await owner.flush(state);
            } catch {
              await owner.disable(state);
            }
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          await owner.disable(state);
          owner.active.delete(state);
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await owner.withdraw(state);
          owner.active.delete(state);
          reader.releaseLock();
        }
      },
    }, { highWaterMark: 0 });
    input.response = new Response(body, {
      status: input.response.status,
      statusText: input.response.statusText,
      headers: input.response.headers,
    });
  }

  async websocketSend(input: SessionWebSocketSend) {
    if (this.disposed || input.kind !== "primary") return;
    let value: { type?: string };
    try { value = JSON.parse(input.frame) as { type?: string }; }
    catch {
      try {
        if (await this.options.isManagedSession(input.sessionID)) {
          this.options.warn("OpenCode file preview received an unsupported outbound frame; native execution is unchanged.");
        }
      } catch {
        this.options.warn("OpenCode file preview session lookup failed; native execution is unchanged.");
      }
      return;
    }
    if (!value || typeof value !== "object" || value.type !== "response.create") return;
    const previous = this.sockets.get(input.sessionID);
    if (previous) {
      await this.withdraw(previous);
      this.active.delete(previous);
      this.sockets.delete(input.sessionID);
    }
    const state = await this.begin(input.sessionID);
    if (state) this.sockets.set(input.sessionID, state);
  }

  async websocketReceive(input: SessionWebSocketReceive) {
    const state = this.sockets.get(input.sessionID);
    if (!state || state.disabled || this.disposed || input.kind !== "primary") return;
    try {
      const value = JSON.parse(input.frame) as { type?: string };
      state.decoder.accept(value);
      await this.flush(state);
      if (["response.completed", "response.incomplete", "response.failed", "error"].includes(value.type ?? "")) {
        if (value.type === "response.failed" || value.type === "error") await this.withdraw(state);
        this.active.delete(state);
        this.sockets.delete(input.sessionID);
      }
    } catch {
      await this.disable(state);
      this.active.delete(state);
      this.sockets.delete(input.sessionID);
    }
  }

  async dispose() {
    this.disposed = true;
    await Promise.all([...this.active].map(state => this.withdraw(state)));
    this.active.clear();
    this.sockets.clear();
  }

  async settleSession(sessionID: string) {
    const states = [...this.active].filter(state => state.sessionID === sessionID);
    await Promise.all(states.map(state => this.withdraw(state)));
    for (const state of states) this.active.delete(state);
    this.sockets.delete(sessionID);
  }

  private async begin(sessionID: string): Promise<RequestState | null> {
    try {
      if (!await this.options.isManagedSession(sessionID) || this.disposed) return null;
      const tools: RequestState["tools"] = new Map();
      const pending: RequestState["pending"] = new Map();
      const requestID = randomUUID();
      const state: RequestState = {
        sessionID, requestID, tools, pending, disabled: false,
        decoder: new OpenCodeToolStream(input => {
          if (input.kind === "start") {
            if (input.tool !== "patch" && input.tool !== "edit" && input.tool !== "write") return;
            tools.set(input.id, { tool: input.tool, parser: new OpenCodePatchPreview(input.tool) });
            return;
          }
          const call = tools.get(input.id);
          if (!call) return;
          if (input.kind === "replace") call.parser = new OpenCodePatchPreview(call.tool);
          const files = call.parser.append(input.text);
          if (files || input.kind === "replace") pending.set(input.id, {
            kind: "preview", sessionID, requestID, callID: input.id, tool: call.tool, files: files ?? [],
          });
        }),
      };
      await this.options.emit({ kind: "request", sessionID, requestID });
      this.active.add(state);
      return state;
    } catch {
      this.options.warn("OpenCode file preview could not start; native execution is unchanged.");
      return null;
    }
  }

  private async flush(state: RequestState) {
    for (const preview of state.pending.values()) await this.options.emit(preview);
    state.pending.clear();
  }

  private async disable(state: RequestState) {
    if (state.disabled) return;
    this.options.warn("OpenCode file preview observation failed; native execution is unchanged.");
    await this.withdraw(state);
  }

  private async withdraw(state: RequestState) {
    state.disabled = true;
    state.tools.clear();
    state.pending.clear();
    try {
      await this.options.emit({ kind: "withdraw", sessionID: state.sessionID, requestID: state.requestID });
    } catch {
      this.options.warn("OpenCode file preview withdrawal failed; native settlement remains authoritative.");
    }
  }
}
