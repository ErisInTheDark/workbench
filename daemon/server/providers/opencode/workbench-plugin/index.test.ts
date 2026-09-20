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
  createLifecycleOwnedCompanionToolOwner,
  createOpenCodeWorkbenchPlugin,
  readOpenCodeGoQuota,
} from "./index";

test("normalises all OpenCode Go windows without returning the credential", async () => {
  const seen: string[] = [];
  const result = await readOpenCodeGoQuota({
    now: () => 100,
    resolveCredential: async () => ({ type: "key", key: "secret-value" }),
    fetch: async (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: 12, resetsAt: "2026-09-20T01:00:00.000Z" },
          weekly: { status: "ok", percent: 34, resetsAt: "2026-09-27T01:00:00.000Z" },
          monthly: { status: "limited", percent: 56, resetsAt: "2026-10-20T01:00:00.000Z" },
        },
      }), { status: 200 });
    },
  });
  assert.deepEqual(seen, ["Bearer secret-value"]);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.deepEqual(Object.keys(result.windows), ["rolling", "weekly", "monthly"]);
  assert.equal(result.observedAt, 100);
  const unavailable = await readOpenCodeGoQuota({
    resolveCredential: async () => ({ type: "key", key: "secret-value" }),
    fetch: async () => new Response(null, { status: 403 }),
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.windows, null);
});

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

test("replaces a failed companion transport without replaying its tool call", async () => {
  const calls: number[] = [];
  const closes: number[] = [];
  let connections = 0;
  const owner = createLifecycleOwnedCompanionToolOwner(async () => {
    const connection = ++connections;
    return {
      callTool: async () => {
        calls.push(connection);
        if (connection === 1) throw new Error("transport failed");
        return { content: [{ type: "text", text: "recovered" }] };
      },
      close: async () => { closes.push(connection); },
    };
  }, "http://127.0.0.1:43001/mcp");
  await assert.rejects(owner.call({ name: "rg" }), /transport failed/u);
  assert.deepEqual(await owner.call({ name: "rg" }), {
    content: "recovered",
    output: { content: [{ type: "text", text: "recovered" }] },
  });
  await owner.close();
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(closes, [1, 2]);
});

test("keeps native file tools, replaces managed shell, and shares one Workbench client", async t => {
  let contextHook: ((input: {
    sessionID: string;
    tools: Record<string, { description: string; input: object }>;
  }) => Promise<void> | void) | undefined;
  type ExecuteHook = (input: {
    id: string;
    input: unknown;
    sessionID: string;
    tool: string;
  }) => Promise<void> | void;
  let executeBefore: ExecuteHook | undefined;
  let executeAfter: ExecuteHook | undefined;
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
    isManagedSession: async sessionID => sessionID.startsWith("managed"),
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
    rpc: { register: async () => ({ dispose: async () => undefined }) },
    integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
    session: {
      hook: async (name: string, callback: typeof contextHook | typeof httpRequest) => {
        if (name === "context") contextHook = callback as typeof contextHook;
        if (name === "http.request") httpRequest = callback as typeof httpRequest;
        return { dispose: async () => undefined };
      },
    },
    tool: {
      hook: async (name: string, callback: ExecuteHook) => {
        if (name === "execute.before") executeBefore = callback;
        if (name === "execute.after") executeAfter = callback;
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
    assert.equal(closedTools, 1);
  });

  assert.ok(contextHook && executeBefore && executeAfter && toolTransform && httpRequest);
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
  const firstInput = {};
  const secondInput = {};
  await executeBefore({
    id: "call-one", input: firstInput, sessionID: "managed-one", tool: "wb_task_get",
  });
  await executeBefore({
    id: "call-two", input: secondInput, sessionID: "managed-two", tool: "wb_task_get",
  });
  assert.deepEqual(await Promise.all([
    workbenchTool.execute(secondInput, { sessionID: "wrong-second" }),
    workbenchTool.execute(firstInput, { sessionID: "wrong-first" }),
  ]), [{
    content: "task",
    output: { content: [{ type: "text", text: "task" }] },
  }, {
    content: "task",
    output: { content: [{ type: "text", text: "task" }] },
  }]);
  assert.deepEqual(calls, [{
    name: "task_get",
    arguments: {},
    _meta: { sessionID: "managed-two" },
  }, {
    name: "task_get",
    arguments: {},
    _meta: { sessionID: "managed-one" },
  }]);
  assert.equal(connectedTools, 1);
  assert.equal(closedTools, 0);

  const ordinaryTools = {
    bash: { description: "native", input: {} },
    wb_shell: { description: "workbench", input: {} },
  };
  await contextHook({ sessionID: "ordinary", tools: ordinaryTools });
  assert.ok("bash" in ordinaryTools);
  assert.ok(!("wb_shell" in ordinaryTools));

  const managedTools = {
    bash: { description: "native", input: {} },
    shell: { description: "native", input: {} },
    execute: { description: "native", input: {} },
    apply_patch: { description: "native", input: {} },
    edit: { description: "native", input: {} },
    read: { description: "native", input: {} },
    wb_shell: { description: "workbench", input: {} },
  };
  await contextHook({ sessionID: "managed", tools: managedTools });
  assert.ok(!("bash" in managedTools));
  assert.ok(!("shell" in managedTools));
  assert.ok("execute" in managedTools);
  assert.ok("apply_patch" in managedTools);
  assert.ok("edit" in managedTools);
  assert.ok("read" in managedTools);
  assert.ok("wb_shell" in managedTools);

  await assert.rejects(
    Promise.resolve(executeBefore({ id: "bash", input: {}, sessionID: "managed", tool: "bash" })),
    /native OpenCode tool.*managed Workbench session/iu,
  );
  await assert.rejects(
    Promise.resolve(executeBefore({ id: "shell", input: {}, sessionID: "managed", tool: "shell" })),
    /native OpenCode tool.*managed Workbench session/iu,
  );
  await executeBefore({ id: "edit", input: {}, sessionID: "managed", tool: "edit" });
  await executeBefore({ id: "execute", input: {}, sessionID: "managed", tool: "execute" });
  await executeBefore({ id: "bash", input: {}, sessionID: "ordinary", tool: "bash" });
  const abandoned = {};
  await executeBefore({
    id: "abandoned", input: abandoned, sessionID: "managed", tool: "wb_task_get",
  });
  await executeAfter({
    id: "abandoned", input: abandoned, sessionID: "managed", tool: "wb_task_get",
  });

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
  const requests: Array<{ body: string; method: string; session: string | undefined }> = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requests.push({
      body: Buffer.concat(chunks).toString("utf8"),
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
  let executeBefore: ((input: {
    id: string; input: unknown; sessionID: string; tool: string;
  }) => Promise<void> | void) | undefined;
  const plugin = createOpenCodeWorkbenchPlugin({
    connectTools: async url => {
      proxyUrl = url;
      return {
        close: async () => undefined,
        callTool: async () => ({ content: [] }),
      };
    },
    isManagedSession: async sessionID => sessionID === "managed",
    resolveDaemonOrigin: async () => `http://127.0.0.1:${address.port}`,
  });
  const cleanup = await plugin.setup({
    rpc: { register: async () => ({ dispose: async () => undefined }) },
    integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
    session: { hook: async () => ({ dispose: async () => undefined }) },
    tool: {
      hook: async (name: string, callback: typeof executeBefore) => {
        if (name === "execute.before") executeBefore = callback;
        return { dispose: async () => undefined };
      },
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
  assert.ok(executeBefore);
  const nestedArguments = { args: ["pattern"] };
  await executeBefore({
    id: "nested-call", input: nestedArguments, sessionID: "managed", tool: "wb_rg",
  });
  const nested = await fetch(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "rg", arguments: nestedArguments, _meta: { progressToken: 7 } },
    }),
  });
  assert.equal(nested.status, 200);
  await nested.text();
  const deleted = await fetch(proxyUrl, {
    method: "DELETE",
    headers: { "mcp-session-id": "current-session" },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(requests, [
    { body: "{}", method: "POST", session: "current-session" },
    {
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "rg",
          arguments: { args: ["pattern"] },
          _meta: { progressToken: 7, sessionID: "managed" },
        },
      }),
      method: "POST",
      session: undefined,
    },
    { body: "", method: "DELETE", session: "current-session" },
  ]);
});
