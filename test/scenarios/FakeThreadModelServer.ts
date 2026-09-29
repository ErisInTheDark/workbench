/*
 * Exports:
 * - FakeThreadAction: one test-authored model response and optional tool request.
 * - default FakeThreadModelServer: own a disposable loopback model endpoint for provider scenarios.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type FakeThreadAction = {
  text?: string;
  tool?: { nameSuffix: string; arguments: Record<string, unknown> }
    | { nameSuffix: string; input: string };
};

type ProviderWire = "codex" | "opencode" | "claude";
type Tool = { type?: string; name?: string; namespace?: string; function?: { name?: string }; tools?: Tool[] };
type ModelRequest = {
  input?: Array<{ type?: string; call_id?: string; tools?: Tool[] }>;
  messages?: Array<{
    role?: string;
    tool_call_id?: string;
    content?: string | Array<{ type?: string; tool_use_id?: string }>;
  }>;
  model?: string;
  stream?: boolean;
  tools?: Tool[];
};
type PendingResult = { callId: string; provider: ProviderWire };

function event(value: object, type?: string) {
  return `${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
}

async function readRequest(request: IncomingMessage): Promise<ModelRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 8 * 1024 * 1024) throw new Error("Fake model request exceeded its byte budget.");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fake model request.");
  return value as ModelRequest;
}

export default class FakeThreadModelServer {
  private readonly actions: FakeThreadAction[] = [];
  private pendingResult: PendingResult | null = null;
  private failure: Error | null = null;
  private closed = false;
  private forbiddenPromptText: string | null = null;
  private requiredPromptText: string | null = null;
  private readonly nextPromptText: string[][] = [];

  private constructor(private readonly server: Server, readonly baseUrl: string) {}

  get lastFailure() { return this.failure; }

  private recordFailure(error: unknown) {
    this.failure ??= error instanceof Error ? error : new Error("Fake model request failed.");
  }

  static async start() {
    let owner: FakeThreadModelServer | null = null;
    const server = createServer((request, response) => {
      void owner?.handle(request, response).catch(error => {
        owner?.recordFailure(error);
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error("Fake model failed."));
          return;
        }
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message.slice(0, 300) : "Fake model failed.");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fake model did not bind a loopback port.");
    owner = new FakeThreadModelServer(server, `http://127.0.0.1:${address.port}`);
    return owner;
  }

  enqueue(actions: readonly FakeThreadAction[]) {
    if (this.closed) throw new Error("Fake model is closed.");
    this.actions.push(...actions);
  }

  forbidPromptText(text: string) {
    this.forbiddenPromptText = text;
  }

  requirePromptText(text: string) {
    this.requiredPromptText = text;
  }

  expectNextPromptText(...texts: string[]) {
    this.nextPromptText.push(texts);
  }

  forgetInterruptedTool() {
    this.pendingResult = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const route = new URL(request.url ?? "/", this.baseUrl).pathname;
    if (request.method === "HEAD" && route === "/api/hello") {
      response.writeHead(200);
      response.end();
      return;
    }
    const provider: ProviderWire = route === "/v1/responses" ? "codex"
      : route === "/v1/chat/completions" ? "opencode"
        : route === "/v1/messages" ? "claude"
        : (() => { throw new Error("Unsupported fake model route."); })();
    if (request.method !== "POST") throw new Error("Fake model accepts POST only.");
    const body = await readRequest(request);
    if (this.forbiddenPromptText && JSON.stringify(body).includes(this.forbiddenPromptText)) {
      throw new Error("A forbidden native instruction reached the fake model.");
    }
    if (this.requiredPromptText && !JSON.stringify(body).includes(this.requiredPromptText)) {
      throw new Error("A required Workbench instruction did not reach the fake model.");
    }
    const expected = this.nextPromptText[0];
    if (expected) {
      const requestText = JSON.stringify(body);
      const missing = expected.filter(text => !requestText.includes(JSON.stringify(text).slice(1, -1)));
      if (missing.length) {
        throw new Error(`Hidden Workbench context missing from next model request: ${missing.map(text => text.slice(0, 80)).join(", ")}`);
      }
      this.nextPromptText.shift();
    }
    if (body.stream !== true) throw new Error("Fake model requires streaming requests.");
    if (provider === "opencode" && !body.tools?.length
      && body.messages?.length === 2
      && body.messages[0]?.role === "system" && body.messages[1]?.role === "user"
      && JSON.stringify(body.messages[0]).toLowerCase().includes("title")) {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
      });
      this.openCodeResponse(response, { text: "Scenario" }, undefined, null);
      response.end();
      return;
    }
    if (this.pendingResult) {
      const pending = this.pendingResult;
      const observed = pending.provider === "codex"
        ? body.input?.some(item => ["function_call_output", "custom_tool_call_output"].includes(item.type ?? "")
          && item.call_id === pending.callId)
        : pending.provider === "opencode"
          ? body.messages?.some(item => item.role === "tool" && item.tool_call_id === pending.callId)
          : body.messages?.some(item => item.role === "user" && Array.isArray(item.content)
            && item.content.some(part => part.type === "tool_result" && part.tool_use_id === pending.callId));
      if (pending.provider !== provider || !observed) {
        this.recordFailure(new Error("Fake model tool result was not observed."));
        response.writeHead(409);
        response.end("Fake model tool result was not observed.");
        return;
      }
    }
    const action = this.actions[0];
    if (!action) throw new Error("Unexpected fake model request.");
    const advertised = body.tools?.length ? body.tools
      : body.input?.find(item => item.type === "additional_tools")?.tools ?? body.tools ?? [];
    const tools = advertised.flatMap(tool => tool.type === "namespace"
      ? (tool.tools ?? []).map(inner => ({ ...inner, namespace: tool.name }))
      : [tool]);
    if (provider === "claude" && tools.some(tool => (tool.name ?? tool.function?.name) === "Bash")) {
      throw new Error("Claude exposed native Bash in fake mode.");
    }
    const matches = action.tool ? tools.filter(tool => {
      const name = tool.name ?? tool.function?.name ?? "";
      return name === action.tool?.nameSuffix || name.endsWith(`__${action.tool?.nameSuffix}`)
        || name.endsWith(`_${action.tool?.nameSuffix}`) || name.endsWith(`.${action.tool?.nameSuffix}`);
    }) : [];
    if (action.tool && matches.length !== 1) {
      const offered = tools.slice(0, 20).map(tool => (tool.name ?? tool.function?.name ?? "").slice(0, 80));
      throw new Error(`Expected fake model tool ${action.tool.nameSuffix} is unavailable or ambiguous; offered: ${offered.join(", ") || "none"}; request fields: ${Object.keys(body).sort().join(", ")}`);
    }
    if (action.tool && ("input" in action.tool) !== (provider === "codex" && matches[0]?.type === "custom")) {
      throw new Error("Fake model tool wire type does not match its scripted action.");
    }
    this.actions.shift();
    const callId = action.tool ? `${provider === "claude" ? "toolu" : "call"}_${randomUUID()}` : null;
    this.pendingResult = callId ? { callId, provider } : null;
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    if (provider === "codex") {
      await this.codexResponse(response, action, matches[0], callId);
    } else if (provider === "opencode") {
      this.openCodeResponse(response, action, matches[0], callId);
    } else {
      this.claudeResponse(response, body.model ?? "claude-sonnet-4-6", action, matches[0], callId);
    }
    response.end();
  }

  private async codexResponse(response: ServerResponse, action: FakeThreadAction, tool: Tool | undefined, callId: string | null) {
    const id = `resp_${randomUUID()}`;
    const output: object[] = [];
    if (action.text !== undefined) output.push({
      type: "message", role: "assistant", id: `msg_${randomUUID()}`,
      phase: action.tool ? "commentary" : "final_answer",
      content: [{ type: "output_text", text: action.text }],
    });
    if (action.tool && callId && tool) {
      const name = tool.name ?? tool.function?.name;
      if ("input" in action.tool) output.push({
        type: "custom_tool_call", call_id: callId, name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        input: action.tool.input,
      });
      else output.push({
        type: "function_call", call_id: callId, name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        arguments: JSON.stringify(action.tool.arguments),
      });
    }
    response.write(event({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
      "response.created"));
    for (const [output_index, item] of output.entries()) {
      if ("type" in item && item.type === "message" && action.text !== undefined) {
        response.write(event({
          type: "response.output_item.added", output_index,
          item: { ...item, content: [{ type: "output_text", text: "" }] },
        }, "response.output_item.added"));
        await new Promise<void>((resolve, reject) => response.write(event({
          type: "response.output_text.delta", output_index, content_index: 0, delta: action.text,
        }, "response.output_text.delta"), error => error ? reject(error) : resolve()));
      }
      response.write(event({ type: "response.output_item.done", output_index, item }, "response.output_item.done"));
    }
    response.write(event({
      type: "response.completed",
      response: {
        id, object: "response", status: "completed", output,
        usage: {
          input_tokens: 1, input_tokens_details: null,
          output_tokens: 1, output_tokens_details: null, total_tokens: 2,
        },
      },
    }, "response.completed"));
  }

  private openCodeResponse(response: ServerResponse, action: FakeThreadAction, tool: Tool | undefined, callId: string | null) {
    const id = `chatcmpl_${randomUUID()}`;
    const chunk = (delta: object, finish_reason: string | null = null) => event({
      id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fake",
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.write(chunk({ role: "assistant" }));
    if (action.text !== undefined) response.write(chunk({ content: action.text }));
    if (action.tool && callId && tool && "arguments" in action.tool) response.write(chunk({
      tool_calls: [{
        index: 0, id: callId, type: "function",
        function: { name: tool.name ?? tool.function?.name, arguments: JSON.stringify(action.tool.arguments) },
      }],
    }));
    response.write(chunk({}, action.tool ? "tool_calls" : "stop"));
    response.write("data: [DONE]\n\n");
  }

  private claudeResponse(
    response: ServerResponse, model: string, action: FakeThreadAction, tool: Tool | undefined, callId: string | null,
  ) {
    const emit = (value: object) => response.write(event(value, (value as { type: string }).type));
    emit({
      type: "message_start",
      message: {
        id: `msg_${randomUUID()}`, type: "message", role: "assistant", content: [], model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    let index = 0;
    if (action.text !== undefined) {
      emit({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      emit({ type: "content_block_delta", index, delta: { type: "text_delta", text: action.text } });
      emit({ type: "content_block_stop", index });
      index++;
    }
    if (action.tool && callId && tool && "arguments" in action.tool) {
      emit({
        type: "content_block_start", index,
        content_block: { type: "tool_use", id: callId, name: tool.name, input: {} },
      });
      emit({
        type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(action.tool.arguments) },
      });
      emit({ type: "content_block_stop", index });
    }
    emit({
      type: "message_delta",
      delta: { stop_reason: action.tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    emit({ type: "message_stop" });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}
