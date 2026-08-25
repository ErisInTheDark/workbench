/*
 * Exports:
 * - No production exports; Node tests cover typed MCP inventory, trusted identity, structured dispatch, bounded errors, and cancellation. Keywords: workbench, MCP, HTTP, tools, identity, cancellation, test.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { listWorkbenchAgentCommands } from "../lib/workbench/commands/workbench-agent-command-registry";
import type { WorkbenchAgentCommandRequest } from "../lib/workbench/commands/workbench-agent-command-definition";
import WorkbenchAgentMcpController from "./WorkbenchAgentMcpController";
import { WorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

const reloadCatalog = [
  { access: "agent" as const, description: "MCP", safeAll: true, scope: "server:mcp" },
  { access: "agent" as const, description: "Topology", safeAll: false, scope: "server:topology" },
  { access: "cli" as const, description: "Codex app-server", safeAll: false, scope: "harness:codex" },
  { access: "operator" as const, description: "Process", safeAll: false, scope: "server:process" },
];

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function startController(getController: WorkbenchAgentMcpController | (() => WorkbenchAgentMcpController)) {
  let releasedRequestCount = 0;
  const server = http.createServer((request, response) => {
    const controller = typeof getController === "function" ? getController() : getController;
    void controller.handleHttpRequest(request, response).then(() => { releasedRequestCount += 1; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    getReleasedRequestCount: () => releasedRequestCount,
    url: new URL(`http://127.0.0.1:${address.port}/orchestrator/mcp`),
  };
}

async function connectClient(url: URL) {
  const client = new Client({ name: "workbench-mcp-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

function responseText(result: unknown) {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((item) => (
    item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
      ? [item.text]
      : []
  )).join("\n");
}

test("lists one typed tool per eligible command and dispatches with trusted thread cwd", async () => {
  const executed: WorkbenchAgentCommandRequest[] = [];
  const codexRequests: Array<{ method?: string; params?: unknown }> = [];
  const controller = new WorkbenchAgentMcpController({
    executeCommand: async (request) => {
      executed.push(request);
      return Response.json({ title: "Typed Workbench" });
    },
    getReloadScopeCatalog: () => reloadCatalog,
    orchestratorOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    requestCodex: async (request) => {
      codexRequests.push(request);
      return { id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } };
    },
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  const capableUrl = new URL(server.url);
  capableUrl.searchParams.set("capabilities", "reload-scopes");
  const capableClient = await connectClient(capableUrl);
  try {
    const inventory = await client.listTools();
    const eligible = listWorkbenchAgentCommands(reloadCatalog, "agent").filter(({ hideFromMcp }) => !hideFromMcp);
    assert.equal(inventory.tools.length, eligible.length);
    assert.equal(inventory.tools.some(({ name }) => name === "browse_raw"), false);
    const plan = inventory.tools.find(({ name }) => name === "git_arc_plan");
    assert.ok(plan);
    assert.deepEqual(Object.keys(plan.inputSchema.properties ?? {}).sort(), ["adoptPaths", "intentDescription", "intentName", "paths", "roots"]);
    assert.equal("args" in (plan.inputSchema.properties ?? {}), false);
    const capablePlan = (await capableClient.listTools()).tools.find(({ name }) => name === "git_arc_plan");
    assert.ok(capablePlan);
    assert.deepEqual(Object.keys(capablePlan.inputSchema.properties ?? {}).sort(), ["adoptPaths", "intentDescription", "intentName", "paths", "roots"]);
    const planProperties = plan.inputSchema.properties as Record<string, { description?: string }>;
    assert.match(plan.description ?? "", /sibling-claimed files in paths/u);
    assert.match(planProperties.paths?.description ?? "", /sibling-claimed files.*does not claim/u);
    assert.match(planProperties.adoptPaths?.description ?? "", /dirty unclaimed work.*Never use for sibling-owned changes/u);
    assert.match(planProperties.adoptPaths?.description ?? "", /may overlap ordinary scope.*minimal claim/u);
    const reload = inventory.tools.find(({ name }) => name === "orchestrator_reload");
    assert.ok(reload);
    const reloadScopes = reload.inputSchema.properties?.scopes as { items?: { enum?: string[] } } | undefined;
    assert.equal(reloadScopes?.items?.enum?.includes("server:process"), false);
    assert.equal(reloadScopes?.items?.enum?.includes("server:mcp"), true);
    const resume = inventory.tools.find(({ name }) => name === "thread_resume");
    assert.ok(resume);
    assert.deepEqual(resume.inputSchema.properties, {});

    for (const [toolName, action, responseKind] of [
      ["git_arc_compare", "compare", "git-arc-compare"],
      ["git_arc_diff", "diff", "git-arc-diff"],
    ] as const) {
      const tool = inventory.tools.find(({ name }) => name === toolName);
      assert.ok(tool);
      assert.equal(tool.inputSchema.required?.includes("paths") ?? false, false);
      const definition = eligible.find(({ words }) => words.join("_") === toolName);
      assert.ok(definition);
      assert.deepEqual(await definition.buildRequestFromJson({}, {
        callerHarness: "codex",
        callerThreadId: "thread-1",
        cwd: "C:/authoritative",
        workbenchOrigin: null,
      }), {
        body: { action, cwd: "C:/authoritative", harness: "codex", threadId: "thread-1" },
        method: "POST",
        path: "/api/git-checkpoint",
        responseKind,
      });
    }

    const result = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {},
      name: "thread_title_get",
    });
    assert.equal(result.isError, false);
    assert.match(responseText(result), /Thread title: Typed Workbench/u);
    assert.deepEqual(codexRequests.at(-1), {
      id: 0,
      method: "thread/read",
      params: { includeTurns: false, threadId: "thread-1" },
    });
    assert.deepEqual(executed.at(-1), {
      body: { action: "get", callerThreadId: "thread-1", cwd: "C:/authoritative" },
      method: "POST",
      path: "/api/thread-title",
      responseKind: "thread-title-get",
    });
    assert.ok(server.getReleasedRequestCount() >= 3);
  } finally {
    await capableClient.close();
    await client.close();
    await server.close();
  }
});

test("fails closed without trusted identity and sanitizes boundary failures", async () => {
  let codexReadCount = 0;
  const logged: string[] = [];
  const controller = new WorkbenchAgentMcpController({
    executeCommand: async () => { throw new Error("unexpected execution"); },
    lifecycleLogError: (_name, message) => { logged.push(message); },
    orchestratorOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    requestCodex: async () => {
      codexReadCount += 1;
      throw new Error("token=super-secret C:/Users/chiri/private.txt");
    },
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const missingIdentity = await client.callTool({ arguments: {}, name: "thread_title_get" });
    assert.equal(missingIdentity.isError, true);
    assert.match(responseText(missingIdentity), /trusted MCP thread identity/u);
    assert.equal(codexReadCount, 0);

    const sanitized = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {},
      name: "thread_title_get",
    });
    assert.equal(sanitized.isError, true);
    assert.doesNotMatch(responseText(sanitized), /super-secret|Users/u);
    assert.match(responseText(sanitized), /token=\[redacted\]|\[path\]/u);
    assert.equal(logged.some((message) => /super-secret|Users/u.test(message)), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("isolates duplicate protocol IDs and cancellation by configured MCP client", { timeout: 5_000 }, async () => {
  const executions = new Map<string, { resolve: (response: Response) => void; signal: AbortSignal }>();
  const bothStarted = deferred<void>();
  const firstAborted = deferred<unknown>();
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const controller = new WorkbenchAgentMcpController({
    executeCommand: async (request, signal) => await new Promise<Response>((resolve, reject) => {
      const callerThreadId = String(request.body?.callerThreadId ?? "");
      executions.set(callerThreadId, { resolve, signal });
      if (executions.size === 2) bothStarted.resolve();
      signal.addEventListener("abort", () => {
        if (callerThreadId === "thread-1") firstAborted.resolve(signal.reason);
        reject(signal.reason);
      }, { once: true });
    }),
    orchestratorOrigin: "http://127.0.0.1:4500",
    requestCodex: async (request) => ({ id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } }),
    requestRegistry,
  });
  const server = await startController(controller);
  const firstUrl = new URL(server.url);
  firstUrl.searchParams.set("client", "11111111-1111-4111-8111-111111111111");
  const secondUrl = new URL(server.url);
  secondUrl.searchParams.set("client", "22222222-2222-4222-8222-222222222222");
  const firstClient = await connectClient(firstUrl);
  const secondClient = await connectClient(secondUrl);
  const firstAbort = new AbortController();
  try {
    const firstCall = firstClient.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {},
      name: "thread_title_get",
    }, undefined, { signal: firstAbort.signal });
    const secondCall = secondClient.callTool({
      _meta: { threadId: "thread-2" },
      arguments: {},
      name: "thread_title_get",
    });
    await bothStarted.promise;
    assert.equal(executions.get("thread-1")?.signal.aborted, false);
    assert.equal(executions.get("thread-2")?.signal.aborted, false);

    firstAbort.abort(new Error("first caller stopped"));
    await assert.rejects(firstCall, /first caller stopped|aborted/u);
    assert.ok(await firstAborted.promise);
    assert.equal(executions.get("thread-2")?.signal.aborted, false);

    executions.get("thread-2")?.resolve(Response.json({ title: "second completed" }));
    const secondResult = await secondCall;
    assert.equal(secondResult.isError, false);
    assert.match(responseText(secondResult), /second completed/u);
  } finally {
    requestRegistry.dispose();
    await firstClient.close();
    await secondClient.close();
    await server.close();
  }
});

test("releases HTTP admission and propagates caller cancellation across controller generations", { timeout: 5_000 }, async () => {
  const executionStarted = deferred<AbortSignal>();
  const executionAborted = deferred<unknown>();
  const logged: string[] = [];
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const createController = () => new WorkbenchAgentMcpController({
    executeCommand: async (_request, signal) => {
      executionStarted.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          executionAborted.resolve(signal.reason);
          reject(signal.reason);
        }, { once: true });
      });
    },
    lifecycleLogError: (_name, message) => { logged.push(message); },
    orchestratorOrigin: "http://127.0.0.1:4500",
    requestRegistry,
    requestCodex: async (request) => ({ id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } }),
  });
  let controller = createController();
  const server = await startController(() => controller);
  const client = await connectClient(server.url);
  const abort = new AbortController();
  try {
    const call = client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { names: ["momo"] },
      name: "subagent_wait",
    }, undefined, { signal: abort.signal });
    const serverSignal = await executionStarted.promise;
    assert.equal(serverSignal.aborted, false);
    assert.ok(server.getReleasedRequestCount() >= 2);
    controller = createController();
    abort.abort(new Error("caller stopped waiting"));
    await assert.rejects(call, /caller stopped waiting|aborted/u);
    assert.ok(await executionAborted.promise);
    assert.deepEqual(logged, []);
  } finally {
    requestRegistry.dispose();
    await client.close();
    await server.close();
  }
});

test("runtime drain aborts declared waits only in the retiring controller generation", { timeout: 5_000 }, async () => {
  const executions = new Map<string, { resolve: (response: Response) => void; signal: AbortSignal }>();
  const bothStarted = deferred<void>();
  const oldStarted = deferred<void>();
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const createController = () => new WorkbenchAgentMcpController({
    executeCommand: async (request, signal) => await new Promise<Response>((resolve, reject) => {
      const callerThreadId = String(request.body?.callerThreadId ?? "");
      executions.set(callerThreadId, { resolve, signal });
      if (callerThreadId === "old-thread") oldStarted.resolve();
      if (executions.size === 2) bothStarted.resolve();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    lifecycleLogError: () => undefined,
    orchestratorOrigin: "http://127.0.0.1:4500",
    requestCodex: async (request) => ({ id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } }),
    requestRegistry,
  });
  const retiringController = createController();
  let currentController = retiringController;
  const server = await startController(() => currentController);
  const oldUrl = new URL(server.url);
  oldUrl.searchParams.set("client", "11111111-1111-4111-8111-111111111111");
  const oldClient = await connectClient(oldUrl);
  try {
    const oldCall = oldClient.callTool({
      _meta: { threadId: "old-thread" },
      arguments: { names: ["momo"] },
      name: "subagent_wait",
    });
    await oldStarted.promise;

    currentController = createController();
    const newUrl = new URL(server.url);
    newUrl.searchParams.set("client", "22222222-2222-4222-8222-222222222222");
    const newClient = await connectClient(newUrl);
    try {
      const newCall = newClient.callTool({
        _meta: { threadId: "new-thread" },
        arguments: { names: ["lumi"] },
        name: "subagent_wait",
      });
      await bothStarted.promise;

      assert.equal(retiringController.beginRuntimeDrain(), 1);
      const oldResult = await oldCall;
      assert.equal(oldResult.isError, true);
      assert.match(responseText(oldResult), /runtime generation is reloading/u);
      assert.equal(executions.get("new-thread")?.signal.aborted, false);

      executions.get("new-thread")?.resolve(new Response("new generation completed"));
      const newResult = await newCall;
      assert.equal(newResult.isError, false);
      assert.match(responseText(newResult), /new generation completed/u);
    } finally {
      await newClient.close();
    }
  } finally {
    requestRegistry.dispose();
    await oldClient.close();
    await server.close();
  }
});
