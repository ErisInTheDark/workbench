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

type ProviderWire = "codex" | "opencode";
type Tool = { type?: string; name?: string; namespace?: string; function?: { name?: string }; tools?: Tool[] };
type ModelRequest = {
  input?: Array<{ type?: string; call_id?: string; tools?: Tool[] }>;
  messages?: Array<{ role?: string; tool_call_id?: string }>;
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

  forgetInterruptedTool() {
    this.pendingResult = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const route = new URL(request.url ?? "/", this.baseUrl).pathname;
    const provider: ProviderWire = route === "/v1/responses" ? "codex"
      : route === "/v1/chat/completions" ? "opencode"
        : (() => { throw new Error("Unsupported fake model route."); })();
    if (request.method !== "POST") throw new Error("Fake model accepts POST only.");
    const body = await readRequest(request);
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
        : body.messages?.some(item => item.role === "tool" && item.tool_call_id === pending.callId);
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
    const callId = action.tool ? `call_${randomUUID()}` : null;
    this.pendingResult = callId ? { callId, provider } : null;
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    if (provider === "codex") {
      await this.codexResponse(response, action, matches[0], callId);
    } else {
      this.openCodeResponse(response, action, matches[0], callId);
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

  async close() {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}
