/*
 * Exports:
 * - tests: protect managed-session tool isolation and ordinary OpenCode session preservation.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  connectLifecycleOwnedCompanionTools,
  createOpenCodeWorkbenchPlugin,
} from "./index";

test("keeps MCP tool calls pending until response or explicit lifecycle closure", async () => {
  const sent: JSONRPCMessage[] = [];
  let onmessage: ((message: JSONRPCMessage) => void) | undefined;
  const client = await connectLifecycleOwnedCompanionTools({
    close: async () => undefined,
    send: async message => {
      sent.push(message);
      if ("method" in message && message.method === "initialize" && "id" in message) {
        queueMicrotask(() => onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "test", version: "1" },
          },
        }));
      }
    },
    setProtocolVersion: () => undefined,
    start: async () => undefined,
    terminateSession: async () => undefined,
    set onclose(_listener) {},
    set onerror(_listener) {},
    set onmessage(listener) { onmessage = listener; },
  });
  const pending = client.callTool({ name: "request_user_input", arguments: {} });
  let settled = false;
  void pending.finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  const call = sent.find(message => "method" in message && message.method === "tools/call");
  assert.ok(call && "id" in call);
  onmessage?.({
    jsonrpc: "2.0",
    id: call.id,
    result: { content: [{ type: "text", text: "answered" }] },
  });
  assert.equal((await pending).content[0]?.type, "text");

  const interrupted = client.callTool({ name: "request_user_input", arguments: {} });
  await client.close();
  await assert.rejects(interrupted, /client closed/u);
});

test("keeps ordinary sessions native while managed sessions use only Workbench mutation tools", async t => {
  let contextHook: ((input: {
    sessionID: string;
    tools: Record<string, { description: string; input: object }>;
  }) => Promise<void> | void) | undefined;
  let executeBefore: ((input: { sessionID: string; tool: string }) => Promise<void> | void) | undefined;
  let httpRequest: ((input: {
    sessionID: string;
    model: { providerID: string };
    request: Request;
  }) => Promise<void> | void) | undefined;
  let toolTransform: ((editor: {
    list(): readonly {
      id: string;
      name: string;
      input: object;
      description: string;
      execute(input: object, context: { sessionID: string }): Promise<object>;
    }[];
    update(id: string, update: (tool: {
      execute(input: object, context: { sessionID: string }): Promise<object>;
    }) => void): void;
  }) => Promise<void> | void) | undefined;
  const calls: object[] = [];
  let connectedTools = 0;
  let closedTools = 0;
  const plugin = createOpenCodeWorkbenchPlugin({
    createProxy: async () => ({
      url: "http://127.0.0.1:43001/mcp",
      close: async () => undefined,
    }),
    isManagedSession: async sessionID => sessionID === "managed",
    connectTools: async () => {
      connectedTools += 1;
      return {
        close: async () => { closedTools += 1; },
        callTool: async (input: object) => {
          calls.push(input);
          return { content: [{ type: "text", text: "task" }] };
        },
      };
    },
  } as never);
  const cleanup = await plugin.setup({
    app: { version: "2.0.9" },
    session: {
      hook: async (name: string, callback: typeof contextHook | typeof httpRequest) => {
        if (name === "context") contextHook = callback as typeof contextHook;
        if (name === "http.request") httpRequest = callback as typeof httpRequest;
        return { dispose: async () => undefined };
      },
    },
    tool: {
      hook: async (name: string, callback: typeof executeBefore) => {
        if (name === "execute.before") executeBefore = callback;
        return { dispose: async () => undefined };
      },
      transform: async (callback: typeof toolTransform) => {
        toolTransform = callback;
        return { dispose: async () => undefined };
      },
    },
    mcp: {
      transform: async () => ({ dispose: async () => undefined }),
    },
  } as never);
  t.after(async () => {
    if (typeof cleanup === "function") await cleanup();
  });

  assert.ok(contextHook && executeBefore && toolTransform && httpRequest);
  const workbenchTool: {
    id: string;
    name: string;
    input: object;
    description: string;
    execute(input: object, context: { sessionID: string }): Promise<object>;
  } = {
    id: "wb_task_get",
    name: "Read task.",
    input: {},
    description: "Read task.",
    execute: async () => ({ content: "unwrapped" }),
  };
  await toolTransform({
    list: () => [workbenchTool],
    update: (_id, update) => update(workbenchTool),
  });
  const expectedCall = {
    name: "task_get",
    arguments: {},
    _meta: { sessionID: "managed" },
  };
  assert.deepEqual(await workbenchTool.execute({}, { sessionID: "managed" }), {
    content: "task",
    output: { content: [{ type: "text", text: "task" }] },
  });
  assert.deepEqual(await workbenchTool.execute({}, { sessionID: "managed" }), {
    content: "task",
    output: { content: [{ type: "text", text: "task" }] },
  });
  assert.deepEqual(calls, [expectedCall, expectedCall]);
  assert.equal(connectedTools, 2);
  assert.equal(closedTools, 2);

  const ordinaryTools = {
    bash: { description: "native", input: {} },
    wb_shell: { description: "workbench", input: {} },
  };
  await contextHook({ sessionID: "ordinary", tools: ordinaryTools });
  assert.ok("bash" in ordinaryTools);
  assert.ok(!("wb_shell" in ordinaryTools));

  const managedTools = {
    bash: { description: "native", input: {} },
    edit: { description: "native", input: {} },
    wb_shell: { description: "workbench", input: {} },
  };
  await contextHook({ sessionID: "managed", tools: managedTools });
  assert.ok(!("bash" in managedTools));
  assert.ok(!("edit" in managedTools));
  assert.ok("wb_shell" in managedTools);

  await assert.rejects(
    Promise.resolve(executeBefore({ sessionID: "managed", tool: "bash" })),
    /native OpenCode tool.*managed Workbench session/iu,
  );
  await executeBefore({ sessionID: "ordinary", tool: "bash" });

  const openCodeRequest = {
    sessionID: "ses_workbench",
    model: { providerID: "opencode" },
    request: new Request("https://opencode.ai/zen/v1/messages", {
      headers: { existing: "preserved" },
    }),
  };
  await httpRequest(openCodeRequest);
  assert.equal(openCodeRequest.request.headers.get("existing"), "preserved");
  assert.equal(openCodeRequest.request.headers.get("x-opencode-session"), "ses_workbench");
  assert.equal(openCodeRequest.request.headers.get("user-agent"), "opencode/2.0.9");
  const externalRequest = {
    sessionID: "ses_external",
    model: { providerID: "anthropic" },
    request: new Request("https://api.anthropic.com/v1/messages"),
  };
  await httpRequest(externalRequest);
  assert.equal(externalRequest.request.headers.has("x-opencode-session"), false);
});

test("proxies the stateful MCP transport without buffering its lifecycle methods", async t => {
  const requests: Array<{ method: string; session: string | undefined }> = [];
  const upstream = http.createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      session: typeof request.headers["mcp-session-id"] === "string"
        ? request.headers["mcp-session-id"] : undefined,
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "next-session",
    });
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  let proxyUrl = "";
  const plugin = createOpenCodeWorkbenchPlugin({
    connectTools: async url => {
      proxyUrl = url;
      return {
        close: async () => undefined,
        callTool: async () => ({ content: [] }),
      };
    },
    isManagedSession: async () => false,
    resolveDaemonOrigin: async () => `http://127.0.0.1:${address.port}`,
  });
  const cleanup = await plugin.setup({
    session: { hook: async () => ({ dispose: async () => undefined }) },
    tool: {
      hook: async () => ({ dispose: async () => undefined }),
      transform: async () => ({ dispose: async () => undefined }),
    },
    mcp: {
      transform: async (callback: (editor: {
        set(name: string, value: { type: string; url: string }): void;
      }) => void) => {
        callback({ set: (_name, value) => { proxyUrl = value.url; } });
        return { dispose: async () => undefined };
      },
    },
  } as never);
  t.after(async () => {
    if (typeof cleanup === "function") await cleanup();
  });

  const posted = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "current-session",
    },
    body: "{}",
  });
  assert.equal(posted.headers.get("mcp-session-id"), "next-session");
  assert.equal(await posted.text(), "{}");
  const deleted = await fetch(proxyUrl, {
    method: "DELETE",
    headers: { "mcp-session-id": "current-session" },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(requests, [
    { method: "POST", session: "current-session" },
    { method: "DELETE", session: "current-session" },
  ]);
});
