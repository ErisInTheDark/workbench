/* Exports: none. Tests cover typed MCP inventory, trusted identity, dispatch, connection retirement, waits, and cancellation. */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { listWorkbenchAgentCommands } from "./lib/workbench/commands/workbench-agent-command-registry";
import { workbenchMcpFailure } from "./lib/workbench/commands/mcp-command-definitions";
import {
  getWorkbenchAgentCommandToolName,
  type WorkbenchAgentCommandRequest,
} from "./lib/workbench/commands/workbench-agent-command-definition";
import WorkbenchAgentMcpController, { type WorkbenchAgentMcpControllerOptions } from "./WorkbenchAgentMcpController";
import CodexToolsController from "./CodexToolsController";
import type CodexShellController from "./CodexShellController";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { NativeThreadId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { WorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import { WORKBENCH_SHELL_SANDBOX_CAPABILITY } from "./CodexShellController";
import { parseGitArcFailureReceipt } from "workbench-shared/workbench/git/git-arc-failures";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import {
  isWorkbenchCommandVisibleTo,
  WORKBENCH_PARENT_ONLY_TOOLS,
} from "workbench-shared/workbench/commands/workbench-tool-audience";
import type { WorkbenchAdmittedExecution, WorkbenchPreparedShell, WorkbenchProviderTools, ProviderToolResult, WorkbenchToolTranscriptReference } from "./provider-execution";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import type WorkbenchProvider from "./WorkbenchProvider";

const EXPECTED_PARENT_ONLY_TOOLS = [
  "git_arc_propose",
  "subagent_create",
  "subagent_list",
  "subagent_profiles",
  "subagent_settle",
  "subagent_stop",
  "subagent_wait",
  "task_get",
  "task_set",
] as const;

/** A prepared shell whose run is opaque to the MCP layer; the injected `executeShell` supplies its result. */
function preparedShell(cwd: string): WorkbenchPreparedShell {
  return {
    cwd, shell: "pwsh",
    run: { kind: "sandboxed", label: "test", expensive: false, request: {
      command: ["pwsh", "-Command", "test"], cwd, permissions: { type: "disabled" },
      windowsSandboxLevel: "disabled", windowsSandboxPrivateDesktop: false, workspaceRoots: [cwd],
    } },
  };
}

for (const name of ["task_get", "shell"]) {
  test(`captures complete ${name} results before replying`, async () => {
    const order: string[] = [];
    const results: ProviderToolResult[] = [];
    const reference = { threadId: "thread", turnId: "original-turn", itemId: "item",
      sourceId: "child", parentId: "parent", tool: name, arguments: {}, startedAt: 1 } as WorkbenchToolTranscriptReference;
    const tools: WorkbenchProviderTools = {
      caller: async () => ({ harness: "opencode", threadId: reference.threadId, cwd: "C:/workspace" }),
      describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: false }),
      patchClaims: async () => "",
      prepareShell: async () => preparedShell("C:/workspace"),
      transcript: {
        start: async () => { order.push("start"); return reference; },
        finish: async (pinned, result) => {
          assert.equal(pinned, reference);
          order.push("finish");
          results.push(result);
        },
      },
    };
    const controller = new WorkbenchAgentMcpController({
      tools: () => tools, daemonOrigin: "http://127.0.0.1:4500",
      requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
      executeCommand: async () => { order.push("execute"); return new Response("complete task output"); },
      executeShell: async () => {
        order.push("execute");
        return { exitCode: 3, stdout: "complete stdout", stderr: "complete stderr" };
      },
    });
    const server = await startController(controller);
    const client = await connectClient(server.url);
    try {
      const result = await client.callTool({ name, arguments: name === "shell" ? { command: "test" } : {} });
      assert.deepEqual(order, ["start", "execute", "finish"]);
      assert.deepEqual(results[0]?.content, result.content);
      if (name === "shell") assert.deepEqual(results[0]?.structuredContent, result.structuredContent);
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test("OpenCode context handoff executes without admitting MCP arguments or results", async () => {
  const order: string[] = [];
  const captured: Array<{ arguments: unknown; result?: ProviderToolResult }> = [];
  const reference = {
    threadId: WorkbenchThreadIdSchema.parse("thread"),
    turnId: "turn",
    itemId: "item",
    sourceId: "child",
    parentId: "parent",
    tool: "thread_compact",
    arguments: {},
    startedAt: 1,
  } as WorkbenchToolTranscriptReference;
  const tools: WorkbenchProviderTools = {
    caller: async () => ({ harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("thread"), cwd: "C:/workspace" }),
    describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: false }),
    patchClaims: async () => "",
    transcript: {
      start: async input => {
        order.push("start");
        captured.push({ arguments: input.arguments });
        return reference;
      },
      finish: async (_reference, result) => {
        order.push("finish");
        captured[0]!.result = result;
      },
    },
  };
  const controller = new WorkbenchAgentMcpController({
    tools: () => tools,
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    executeCommand: async request => {
      order.push("execute");
      assert.equal(request.path, "/api/thread-compact");
      assert.deepEqual(request.body, {
        callerThreadId: "thread", cwd: "C:/workspace", summary: "complete handoff",
      });
      return Response.json({ accepted: true });
    },
  });
  const server = await startController(controller);
  server.url.searchParams.set("provider", "opencode");
  const client = await connectClient(server.url);
  try {
    const result = await client.callTool({ name: "thread_compact", arguments: { summary: "complete handoff" } });
    assert.equal(result.isError, false, responseText(result));
    assert.deepEqual(order, ["start", "execute", "finish"]);
    assert.deepEqual(captured, [{
      arguments: {},
      result: { content: [], isError: false },
    }]);
  } finally {
    await client.close();
    await server.close();
  }
});

for (const phase of ["start", "finish", "operation"] as const) {
  test(`capture ${phase} failure never retries or discards executed output`, async () => {
    let executions = 0;
    const recorded: ProviderToolResult[] = [];
    const errors: string[] = [];
    const reference = { threadId: "thread", turnId: "turn", itemId: "item", sourceId: "child",
      parentId: "parent", tool: "task_get", arguments: {}, startedAt: 1 } as WorkbenchToolTranscriptReference;
    const unused = async (): Promise<never> => { throw new Error("unexpected tool"); };
    const tools: WorkbenchProviderTools = {
      caller: async () => ({ harness: "opencode", threadId: reference.threadId, cwd: "C:/workspace" }),
      describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: false }),
      patchClaims: unused, prepareShell: unused,
      transcript: {
        start: async () => { if (phase === "start") throw new Error("capture failed"); return reference; },
        finish: async (_reference, result) => {
          recorded.push(result);
          if (phase === "finish") throw new Error("capture failed");
        },
      },
    };
    const controller = new WorkbenchAgentMcpController({
      tools: () => tools, daemonOrigin: "http://127.0.0.1:4500",
      lifecycleLogError: (...values) => { errors.push(values.join(" ")); },
      requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
      executeCommand: async () => {
        executions++;
        return phase === "operation" ? new Response("actual operation output", { status: 409 })
          : Response.json({ title: "actual operation output" });
      },
    });
    const server = await startController(controller);
    const client = await connectClient(server.url);
    try {
      const result = await client.callTool({ name: "task_get", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(executions, phase === "start" ? 0 : 1);
      if (phase !== "start") {
        assert.match(responseText(result), /actual operation output/);
        assert.ok(recorded[0]?.content.length);
      }
      if (phase !== "operation") assert.ok(errors.length);
      if (phase === "operation") assert.equal(recorded[0]?.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  });
}

function codexController(options: Omit<WorkbenchAgentMcpControllerOptions, "tools"> & {
  transcript?: WorkbenchProviderTools["transcript"];
  requestCodex: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  resolveThreadId?: (nativeId: NativeThreadId, cwd: string) => Promise<WorkbenchThreadId>;
  shell?: Pick<CodexShellController, "prepareAdmitted">;
}) {
  const tools = new CodexToolsController({
    resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
    readCallerThread: async nativeId => {
      const response = await options.requestCodex({
        id: 0, method: "thread/read", params: { includeTurns: false, threadId: nativeId },
      });
      if (response.error) throw new Error(response.error.message);
      const result = response.result as { thread: { cwd: string } };
      return {
        id: options.resolveThreadId
          ? await options.resolveThreadId(nativeId, result.thread.cwd)
          : WorkbenchThreadIdSchema.parse(nativeId),
        cwd: result.thread.cwd,
      };
    },
    shell: {
      prepare: async () => { throw new Error("unexpected native shell execution"); },
      prepareAdmitted: options.shell?.prepareAdmitted ?? (async () => { throw new Error("unexpected shell execution"); }),
    },
  });
  if (options.transcript) Object.assign(tools, { transcript: options.transcript });
  return new WorkbenchAgentMcpController({
    approveHostedShell: async () => { throw new Error("unexpected approval"); },
    ...options,
    tools: provider => {
      assert.equal(provider, "codex");
      return tools;
    },
  });
}

for (const harness of ["codex", "claude", "opencode"] as const) {
  for (const decision of ["allow", "decline", "cancel"] as const) {
    test(`${harness} shell through its provider handle uses Workbench admission and honours ${decision}`, async () => {
      const cwd = process.cwd();
      const threadId = WorkbenchThreadIdSchema.parse("wb-thread");
      const cancellation = new AbortController();
      const permissions: WorkbenchAdmittedExecution["permissions"][] = [];
      const approvals: Parameters<NonNullable<WorkbenchAgentMcpControllerOptions["approveHostedShell"]>>[0][] = [];
      const prepared = preparedShell(cwd);
      let nativeCalls = 0;
      let executions = 0;
      const prepareExecution: NonNullable<WorkbenchProviderTools["prepareExecution"]> = async request => {
        permissions.push(request.permissions);
        return prepared.run;
      };
      const tools: WorkbenchProviderTools = harness === "codex"
        ? new CodexToolsController({
          readCallerThread: async () => ({ id: threadId, cwd }),
          resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
          shell: {
            prepare: async () => { nativeCalls++; return prepared; },
            prepareAdmitted: prepareExecution,
          },
        })
        : {
          caller: async () => ({ harness, threadId, cwd }),
          describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: true }),
          patchClaims: async () => { throw new Error("unexpected patch"); },
          prepareExecution,
        };
      const dispatcher = new WorkbenchProviderDispatcher(
        async (_registration, operation) => operation({ tools } as WorkbenchProvider),
      );
      const controller = new WorkbenchAgentMcpController({
        tools: () => dispatcher.get(harness).tools,
        daemonOrigin: "http://127.0.0.1:4500",
        requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
        lifecycleLogError: () => {},
        approveHostedShell: async request => {
          approvals.push(request);
          if (decision === "cancel") cancellation.abort(new Error("caller cancelled"));
          return decision === "decline" ? { kind: "decline" } : { kind: "allowOnce" };
        },
        executeShell: async () => {
          executions++;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      const call = (requestId: number, outsideSandbox = false) => controller.call(
        { clientScope: "client", projectLocal: false, provider: harness, subagent: false },
        {
          name: "shell", requestId, signal: cancellation.signal,
          meta: { threadId: "native-thread" },
          arguments: {
            command: "echo test",
            ...(outsideSandbox ? { outside_sandbox: true, justification: "needs outside access" } : {}),
          },
        },
      );
      const ordinary = await call(1);
      assert.ok(ordinary.kind === "result");
      assert.equal(ordinary.result.isError, false, responseText(ordinary.result));
      assert.equal(nativeCalls, 0, "the provider handle must not divert ordinary commands to native preparation");
      assert.deepEqual(permissions, [{ mode: "restricted", writableRoots: [cwd], network: false }]);
      assert.equal(approvals.length, 0);
      assert.equal(executions, 1);

      const escalated = await call(2, true);
      assert.ok(escalated.kind === "result");
      assert.equal(escalated.result.isError, decision !== "allow");
      assert.equal(approvals.length, 1);
      assert.deepEqual(approvals[0]?.caller, { harness, threadId, cwd });
      assert.equal(approvals[0]?.subject.cwd, cwd);
      assert.equal(approvals[0]?.subject.justification, "needs outside access");
      assert.equal(executions, decision === "allow" ? 2 : 1);
      assert.deepEqual(permissions.map(value => value.mode),
        decision === "allow" ? ["restricted", "approved-unrestricted"] : ["restricted"]);
      if (decision === "allow") {
        const next = await call(3);
        assert.ok(next.kind === "result" && !next.result.isError);
        assert.deepEqual(permissions.map(value => value.mode), ["restricted", "approved-unrestricted", "restricted"]);
        assert.equal(approvals.length, 1);
        assert.equal(executions, 3);
      }
    });
  }
}

test("MCP preserves typed Git rejections before and after dispatch", async () => {
  let dispatches = 0;
  const controller = codexController({
    executeCommand: async () => { dispatches += 1; throw new GitArcRejectionError({ reason: "missingActiveArc" }); },
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    lifecycleLogError: () => {},
    requestCodex: async (request) => ({ id: request.id ?? null, result: { thread: { cwd: "C:/workspace" } } }),
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    for (const [name, args, reason] of [
      ["git_plan_claims", {}, "missingPlanName"],
      ["git_arc_diff", { paths: ["one.ts"], page: 2 }, "selectedPathPaging"],
    ] as const) {
      const result = await client.callTool({ name, arguments: args, _meta: { threadId: "native-thread" } });
      assert.equal(result.isError, true);
      const failure = parseGitArcFailureReceipt(responseText(result));
      assert.ok(failure && "rejection" in failure, name);
      assert.deepEqual(failure.rejection, { reason });
    }
    assert.equal(dispatches, 0);
    const dispatched = await client.callTool({ name: "git_arc_continue", arguments: {}, _meta: { threadId: "native-thread" } });
    const failure = parseGitArcFailureReceipt(responseText(dispatched));
    assert.equal(dispatched.isError, true);
    assert.equal((dispatched.structuredContent as { kind?: string } | undefined)?.kind, "failure");
    assert.ok(failure && "rejection" in failure);
    assert.deepEqual(failure.rejection, { reason: "missingActiveArc" });
    assert.equal(dispatches, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("deferred commands are found and run through server wb without joining the preloaded tool list", async () => {
  const executed: WorkbenchAgentCommandRequest[] = [];
  const controller = codexController({
    executeCommand: async request => {
      executed.push(request);
      if (request.path === "/internal/mcp") return new Response("No MCP servers are configured.\n");
      return Response.json({ additions: 0, deletions: 0, fileCount: 0, files: [], page: 1, pageCount: 1, phase: "preview", session: "s1" });
    },
    getReloadScopeCatalog: () => reloadCatalog,
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    lifecycleLogError: () => {},
    requestCodex: async request => ({ id: request.id ?? null, result: { thread: { cwd: "C:/workspace" } } }),
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args, _meta: { threadId: "native-thread" } });
  try {
    const names = (await client.listTools()).tools.map(({ name }) => name);
    assert.equal(names.includes("git_arc_edit_start"), false);
    assert.equal(names.includes("mcp_call"), true);

    const searched = responseText(await call("mcp_tools", { server: "wb", query: "edit session preview" }));
    assert.match(searched, /^wb\/git_arc_edit_start$/mu);
    assert.match(searched, /Input schema: .*"operations"/u);
    // Search mirrors CLI help: root-help-hidden commands stay undiscoverable and unrunnable.
    assert.doesNotMatch(responseText(await call("mcp_tools", { server: "wb" })), /wb\/(?:reload|store_get)\b/u);
    const listedAlongside = responseText(await call("mcp_tools", {}));
    assert.match(listedAlongside, /No MCP servers are configured/u);
    assert.match(listedAlongside, /^wb\/git_arc_tree: /mu);

    const operations = [{ kind: "replace", pattern: "    a", replacement: "b" }];
    const ran = await call("mcp_call", { server: "wb", tool: "git_arc_edit_start", arguments: { operations } });
    assert.equal(ran.isError, false, responseText(ran));
    assert.deepEqual(executed.at(-1)?.body?.operations, [{ ...operations[0], flags: "", globs: [], includeIgnored: false, roots: ["."] }]);

    const dispatchesBefore = executed.length;
    for (const args of [
      { server: "wb", tool: "git_arc_edit_start", arguments: { operations: [] } },
      { server: "wb", tool: "reload", arguments: {} },
      { server: "wb", tool: "rg", arguments: { args: ["x"] } },
    ]) assert.equal((await call("mcp_call", args)).isError, true, JSON.stringify(args));
    assert.equal((await call("mcp_request", { server: "wb", tool: "git_arc_tree", reason: "need it" })).isError, true);
    assert.equal(executed.length, dispatchesBefore);
  } finally {
    await client.close();
    await server.close();
  }
});

test("an external tool error whose text is JSON reaches the agent whole", async () => {
  const text = JSON.stringify({ authorization_url: "https://accounts.example.test/auth?a=1&b=2", message: "Authorization required." });
  const controller = codexController({
    executeCommand: async () => workbenchMcpFailure(text, 422),
    getReloadScopeCatalog: () => reloadCatalog,
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    lifecycleLogError: () => {},
    requestCodex: async request => ({ id: request.id ?? null, result: { thread: { cwd: "C:/workspace" } } }),
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const result = await client.callTool({ name: "mcp_call", arguments: { server: "eris", tool: "search" }, _meta: { threadId: "native-thread" } });
    assert.equal(result.isError, true);
    assert.match(responseText(result), /https:\/\/accounts\.example\.test\/auth\?a=1&b=2/u);
  } finally {
    await client.close();
    await server.close();
  }
});

for (const failResolution of [false, true]) test(`shell resolves caller identity from thread cwd with resolution failure=${failResolution}`, async () => {
  const cwd = process.cwd();
  const identities: object[] = [];
  const controller = codexController({
    executeCommand: async () => Response.json({}),
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    lifecycleLogError: () => {},
    requestCodex: async (request) => {
      assert.equal(request.method, "thread/read");
      assert.deepEqual(request.params, { includeTurns: false, threadId: "native-session" });
      return { id: request.id ?? null, result: { thread: { cwd } } };
    },
    resolveThreadId: async (nativeThreadId, cwd) => {
      assert.equal(nativeThreadId, "native-session");
      assert.equal(cwd, process.cwd());
      if (failResolution) throw new Error("identity unavailable");
      return WorkbenchThreadIdSchema.parse("workbench-thread");
    },
    shell: {
      prepareAdmitted: async request => {
        identities.push(request.caller);
        return preparedShell(request.cwd).run;
      },
    },
    executeShell: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const call = () => client.callTool({
      name: "shell",
      _meta: { threadId: "native-session" },
      arguments: { command: "Get-Location", workdir: "." },
    });
    assert.equal((await call()).isError, failResolution);
    assert.deepEqual(identities, failResolution ? [] : [{ harness: "codex", threadId: "workbench-thread", cwd }]);
  } finally {
    await client.close();
    await server.close();
  }
});

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
    // The MCP node activates its committed controller; tests treat the one serving each request as committed.
    controller.activateToolGeneration();
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
    url: new URL(`http://127.0.0.1:${address.port}/daemon/mcp?provider=codex`),
  };
}

async function connectClient(url: URL) {
  const client = new Client({ name: "workbench-mcp-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

for (const outcome of ["success", "tool error", "protocol error", "admission error", "notification"] as const) {
  test(`retires completed MCP connections after ${outcome} without replaying calls`, async context => {
    let executions = 0;
    const controller = codexController({
      daemonOrigin: "http://127.0.0.1:4500",
      requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
      requestCodex: async request => ({
        id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } },
      }),
      executeCommand: async () => {
        executions++;
        return outcome === "tool error"
          ? new Response("operation rejected", { status: 409 })
          : Response.json({ title: "completed" });
      },
    });
    const server = await startController(controller);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    context.after(async () => {
      agent.destroy();
      await server.close();
    });
    if (outcome === "admission error") server.url.searchParams.set("client", "invalid");
    const sockets = new Set<Socket>();
    for (let id = 1; id <= 2; id++) {
      const message = outcome === "notification"
        ? { jsonrpc: "2.0", method: "notifications/initialized" }
        : outcome === "protocol error"
          ? { invalid: true }
          : {
            jsonrpc: "2.0", id, method: "tools/call",
            params: { name: "task_get", arguments: {}, _meta: { threadId: "thread-1" } },
          };
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request(server.url, {
          agent,
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        }, response => {
          response.once("error", reject);
          response.once("end", () => resolve(response.statusCode));
          response.resume();
        });
        request.once("socket", socket => { sockets.add(socket); });
        request.once("error", reject);
        request.end(JSON.stringify(message));
      });
      assert.equal(status, outcome === "notification" ? 202
        : outcome === "admission error" || outcome === "protocol error" ? 400 : 200);
    }
    assert.equal(executions, outcome === "success" || outcome === "tool error" ? 2 : 0);
    assert.equal(sockets.size, 2, "completed responses must not leave a reusable idle socket");
  });
}

function responseText(result: unknown) {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((item) => (
    item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
      ? [item.text]
      : []
  )).join("\n");
}

test("the explicit provider owns MCP metadata and supplies WB command identity", async () => {
  const executed: WorkbenchAgentCommandRequest[] = [];
  const controller = new WorkbenchAgentMcpController({
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    executeCommand: async request => { executed.push(request); return Response.json({ title: "proof" }); },
    tools: provider => {
      assert.equal(provider, "another-provider");
      return {
        describe: async () => ({ experimental: {}, shellDescription: "sandboxed execution", shellEscalation: false }),
        caller: async metadata => {
          assert.deepEqual(metadata, { session: "provider-owned" });
          return { cwd: "/trusted", harness: provider, threadId: WorkbenchThreadIdSchema.parse("wb-caller") };
        },
        shell: async () => { throw new Error("unexpected shell"); },
        patchClaims: async () => { throw new Error("unexpected patch"); },
      };
    },
  });
  const server = await startController(controller);
  server.url.searchParams.set("provider", "another-provider");
  const client = await connectClient(server.url);
  try {
    await client.callTool({ name: "task_get", arguments: {}, _meta: { session: "provider-owned" } });
    const definition = listWorkbenchAgentCommands([], "agent").find(definition => definition.words.join("_") === "task_get")!;
    assert.deepEqual(executed, [await definition.buildRequestFromJson({}, {
      callerHarness: "another-provider", callerThreadId: "wb-caller", cwd: "/trusted",
      workbenchOrigin: "http://127.0.0.1:4500",
    })]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("provider-scoped commands register only for their providers", async () => {
  const controller = new WorkbenchAgentMcpController({
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    executeCommand: async () => { throw new Error("unexpected command"); },
    tools: () => ({
      describe: async () => ({ experimental: {}, shellDescription: "sandboxed execution", shellEscalation: false }),
      caller: async () => { throw new Error("unexpected caller"); },
      shell: async () => { throw new Error("unexpected shell"); },
      patchClaims: async () => { throw new Error("unexpected patch"); },
    }),
  });
  const server = await startController(controller);
  const claudeUrl = new URL(server.url);
  claudeUrl.searchParams.set("provider", "claude");
  const claude = await connectClient(claudeUrl);
  const codex = await connectClient(server.url);
  try {
    assert.equal((await claude.listTools()).tools.some(({ name }) => name === "rm"), true);
    assert.equal((await codex.listTools()).tools.some(({ name }) => name === "rm"), false);
  } finally {
    await claude.close();
    await codex.close();
    await server.close();
  }
});

test("git_repo exists only while the virtual repository runtime is available", async () => {
  let available = false;
  const controller = new WorkbenchAgentMcpController({
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    virtualReposAvailable: () => available,
    executeCommand: async () => { throw new Error("unexpected command"); },
    tools: () => ({
      describe: async () => ({ experimental: {}, shellDescription: "sandboxed execution", shellEscalation: false }),
      caller: async () => { throw new Error("unexpected caller"); },
      shell: async () => { throw new Error("unexpected shell"); },
      patchClaims: async () => { throw new Error("unexpected patch"); },
    }),
  });
  const hasRepoTool = () => controller.listInstructionTools().some(({ id }) => id === "git_repo");
  const server = await startController(controller);
  try {
    const listed = async () => {
      const client = await connectClient(server.url);
      try { return (await client.listTools()).tools.some(({ name }) => name === "git_repo"); }
      finally { await client.close(); }
    };
    assert.equal(await listed(), false);
    assert.equal(hasRepoTool(), false);
    available = true;
    assert.equal(await listed(), true, "a new session must see the tool once the runtime appears");
    assert.equal(hasRepoTool(), true);
    available = false;
    assert.equal(await listed(), false, "the tool must disappear with the runtime");
  } finally {
    await server.close();
  }
});

test("lists one typed tool per eligible command and dispatches with trusted thread cwd", async () => {
  const executed: WorkbenchAgentCommandRequest[] = [];
  const codexRequests: Array<{ method?: string; params?: unknown }> = [];
  const controller = codexController({
    executeCommand: async (request) => {
      executed.push(request);
      return Response.json({ title: "Typed Workbench" });
    },
    getReloadScopeCatalog: () => reloadCatalog,
    daemonOrigin: "http://127.0.0.1:4500",
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
  const projectUrl = new URL(server.url);
  projectUrl.searchParams.set("project-local", "true");
  const projectClient = await connectClient(projectUrl);
  try {
    const inventory = await client.listTools();
    const eligible = listWorkbenchAgentCommands(reloadCatalog, "agent").filter((definition) => (
      !definition.mcpDeferred && !definition.managedThreadRootOnly
      && isWorkbenchCommandVisibleTo(getWorkbenchAgentCommandToolName(definition), {
        harness: "codex",
        harnesses: definition.harnesses,
        subagent: false,
      })
    ));
    const hiddenFromCodex = new Set(listWorkbenchAgentCommands(reloadCatalog, "agent")
      .filter((definition) => !isWorkbenchCommandVisibleTo(getWorkbenchAgentCommandToolName(definition), {
        harness: "codex",
        harnesses: definition.harnesses,
        subagent: false,
      }))
      .map((definition) => definition.words.join("_")));
    assert.equal(inventory.tools.length, eligible.length + 1);
    assert.ok(client.getServerCapabilities()?.experimental?.[WORKBENCH_SHELL_SANDBOX_CAPABILITY]);
    assert.equal(inventory.tools.some(({ name }) => name === "browse_raw"), false);
    assert.equal(inventory.tools.some(({ name }) => name === "tokens"), true);
    assert.equal(inventory.tools.some(({ name }) => name === "tokens_project"), true);
    assert.equal(inventory.tools.some(({ name }) => name === "tokens_instructions"), false);
    assert.equal(inventory.tools.some(({ name }) => name === "message"), true);
    const projectInventory = await projectClient.listTools();
    assert.equal(projectInventory.tools.some(({ name }) => name === "tokens_instructions"), true);
    const instructionTools = controller.listInstructionTools();
    assert.deepEqual(
      instructionTools.filter(({ deferred }) => !deferred).map(({ id }) => id).filter((id) => !hiddenFromCodex.has(id)).sort(),
      projectInventory.tools.map(({ name }) => name).sort(),
    );
    // Deferred commands stay in the instruction catalogue so `<docs>` gates reflect what the agent can use.
    assert.equal(instructionTools.find(({ id }) => id === "git_arc_edit_start")?.deferred, true);
    assert.equal(instructionTools.find(({ id }) => id === "rg")?.codeModeEligible, true);
    assert.equal(instructionTools.find(({ id }) => id === "git_arc_release")?.codeModeEligible, false);
    assert.equal(instructionTools.some(({ id }) => id === "not_a_tool"), false);
    assert.equal(inventory.tools.some(({ name }) => name.startsWith("transcript_")), false);
    assert.equal((await projectClient.listTools()).tools.some(({ name }) => name.startsWith("transcript_")), false);
    const plan = inventory.tools.find(({ name }) => name === "git_plan_claims");
    assert.ok(plan);
    const capablePlan = (await capableClient.listTools()).tools.find(({ name }) => name === "git_plan_claims");
    assert.ok(capablePlan);
    assert.deepEqual(capablePlan.inputSchema, plan.inputSchema);
    const claims = eligible.find(({ words }) => words.join("_") === "git_arc_claims")!;
    const claimRequest = await claims.buildRequestFromJson({
      inherit: true, addPaths: ["-literal.ts"], removePaths: ["old.ts"], adoptPaths: ["dirty.ts"],
    }, { callerHarness: "codex", callerThreadId: "thread-1", cwd: "C:/authoritative", workbenchOrigin: null });
    assert.deepEqual(claimRequest.body, {
      action: "arcClaims", inherit: true, addPaths: ["-literal.ts"], removePaths: ["old.ts"], adoptPaths: ["dirty.ts"], roots: [],
      cwd: "C:/authoritative", harness: "codex", threadId: "thread-1",
    });
    const commit = inventory.tools.find(({ name }) => name === "git_commit");
    assert.ok(commit);
    assert.deepEqual(Object.keys(commit.inputSchema.properties ?? {}).sort(), ["amendTarget", "description", "targetWorktree", "title"]);
    assert.equal(commit.inputSchema.required?.includes("title") ?? false, true);
    assert.equal(commit.inputSchema.required?.includes("description") ?? false, false);
    const proposal = inventory.tools.find(({ name }) => name === "git_arc_propose");
    assert.ok(proposal);
    assert.deepEqual(Object.keys(proposal.inputSchema.properties ?? {}).sort(), [
      "amend", "description", "freshDescription", "freshTitle", "paths", "rootId", "title",
    ]);
    assert.equal(inventory.tools.some(({ name }) => name === "daemon_reload" || name === "reload" || name === "dirt"), false);
    const refresh = inventory.tools.find(({ name }) => name === "thread_refresh");
    assert.ok(refresh);
    assert.deepEqual(refresh.inputSchema.properties, {});
    const title = inventory.tools.find(({ name }) => name === "task_set");
    assert.ok(title);
    assert.deepEqual(Object.keys(title.inputSchema.properties ?? {}).sort(), ["currentTitle", "title"]);
    assert.equal(title.inputSchema.required?.includes("title") ?? false, true);
    assert.equal(title.inputSchema.required?.includes("currentTitle") ?? false, false);
    for (const name of ["task_completed", "task_blocked"]) {
      const status = inventory.tools.find((tool) => tool.name === name);
      assert.ok(status);
      assert.deepEqual(status.inputSchema.properties, {});
    }
    assert.equal(inventory.tools.some(({ name }) => name === "thread_title" || name === "thread_title_get" || name === "thread_status"), false);
    const ripgrep = inventory.tools.find(({ name }) => name === "rg");
    assert.ok(ripgrep);
    assert.deepEqual(Object.keys(ripgrep.inputSchema.properties ?? {}), ["args"]);
    assert.match(ripgrep.description ?? "", /without shell quoting.*no matches/u);
    const shell = inventory.tools.find(({ name }) => name === "shell");
    assert.ok(shell);
    assert.deepEqual(Object.keys(shell.outputSchema?.properties ?? {}).sort(), ["cwd", "exitCode", "queuedMs", "shell", "stderr", "stdout"]);

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
    const diffDefinition = eligible.find(({ words }) => words.join("_") === "git_arc_diff");
    assert.ok(diffDefinition);
    assert.equal("page" in (inventory.tools.find(({ name }) => name === "git_arc_diff")?.inputSchema.properties ?? {}), true);
    assert.equal("threadId" in (inventory.tools.find(({ name }) => name === "git_arc_diff")?.inputSchema.properties ?? {}), true);
    assert.equal("page" in (inventory.tools.find(({ name }) => name === "git_arc_compare")?.inputSchema.properties ?? {}), false);
    assert.deepEqual(await diffDefinition.buildRequestFromJson({ page: 3 }, {
      callerHarness: "codex",
      callerThreadId: "thread-1",
      cwd: "C:/authoritative",
      workbenchOrigin: null,
    }), {
      body: { action: "diff", cwd: "C:/authoritative", harness: "codex", page: 3, threadId: "thread-1" },
      method: "POST",
      path: "/api/git-checkpoint",
      responseKind: "git-arc-diff",
    });
    assert.deepEqual(await diffDefinition.buildRequestFromJson({ ref: "proposal-one", threadId: "target-thread" }, {
      callerHarness: "codex",
      callerThreadId: "thread-1",
      cwd: "C:/authoritative",
      workbenchOrigin: null,
    }), {
      body: {
        action: "diff", cwd: "C:/authoritative", harness: "codex", ref: "proposal-one",
        targetThreadId: "target-thread", threadId: "thread-1",
      },
      method: "POST",
      path: "/api/git-checkpoint",
      responseKind: "git-arc-diff",
    });
    const statusDefinition = eligible.find(({ words }) => words.join("_") === "git_arc_status");
    assert.ok(statusDefinition);
    assert.equal("threadId" in (inventory.tools.find(({ name }) => name === "git_arc_status")?.inputSchema.properties ?? {}), true);
    assert.deepEqual(await statusDefinition.buildRequestFromJson({ threadId: "target-thread" }, {
      callerHarness: "codex",
      callerThreadId: "thread-1",
      cwd: "C:/authoritative",
      workbenchOrigin: null,
    }), {
      body: {
        action: "arcStatus", cwd: "C:/authoritative", full: [], harness: "codex",
        targetThreadId: "target-thread", threadId: "thread-1",
      },
      method: "POST",
      path: "/api/git-checkpoint",
      responseKind: "git-arc-status",
    });

    const release = inventory.tools.find(({ name }) => name === "git_arc_release");
    assert.ok(release);
    assert.ok("toSubagent" in (release.inputSchema.properties ?? {}));
    assert.ok("paths" in (release.inputSchema.properties ?? {}));
    const releaseDefinition = eligible.find(({ words }) => words.join("_") === "git_arc_release");
    assert.ok(releaseDefinition);
    assert.deepEqual(await releaseDefinition.buildRequestFromJson({}, {
      callerHarness: "codex",
      callerThreadId: "thread-1",
      cwd: "C:/authoritative",
      workbenchOrigin: null,
    }), {
      body: { action: "arcRelease", cwd: "C:/authoritative", disown: false, harness: "codex", threadId: "thread-1" },
      method: "POST",
      path: "/api/git-checkpoint",
      responseKind: "git-arc-release",
    });
    assert.deepEqual((await releaseDefinition.buildRequestFromJson({
      toSubagent: "mira", paths: ["src/one.ts"],
    }, {
      callerHarness: "codex", callerThreadId: "thread-1", cwd: "C:/authoritative", workbenchOrigin: null,
    })).body, {
      action: "arcTransferClaims", cwd: "C:/authoritative", harness: "codex", threadId: "thread-1",
      destination: { kind: "subagent", name: "mira" }, paths: ["src/one.ts"],
    });

    const searchResult = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { args: ["-n", "a pattern with 'quotes'", "webapp"] },
      name: "rg",
    });
    assert.equal(searchResult.isError, false);
    assert.deepEqual(executed.at(-1), {
      body: { args: ["-n", "a pattern with 'quotes'", "webapp"], cwd: "C:/authoritative", harness: "codex" },
      method: "POST",
      path: "/api/rg",
      responseKind: "native",
    });

    const instructionTokens = await projectClient.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { model: "gpt-5-test", toc: true },
      name: "tokens_instructions",
    });
    assert.equal(instructionTokens.isError, false);
    assert.deepEqual(executed.at(-1), {
      body: { callerThreadId: "thread-1", cwd: "C:/authoritative", kind: "instructions", model: "gpt-5-test", toc: true },
      method: "POST",
      path: "/internal/tokens",
      responseKind: "native",
    });

    const projectTokens = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { model: "gpt-5-test", toc: true },
      name: "tokens_project",
    });
    assert.equal(projectTokens.isError, false);
    assert.deepEqual(executed.at(-1), {
      body: { cwd: "C:/authoritative", kind: "projectInstructions", model: "gpt-5-test", toc: true },
      method: "POST",
      path: "/internal/tokens",
      responseKind: "native",
    });

    const result = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {},
      name: "task_get",
    });
    assert.equal(result.isError, false);
    assert.match(responseText(result), /Task title: Typed Workbench/u);
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
    const titleSet = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { currentTitle: "Typed Workbench", title: "Preserve overarching titles" },
      name: "task_set",
    });
    assert.equal(titleSet.isError, false);
    assert.deepEqual(executed.at(-1), {
      body: {
        action: "set",
        callerThreadId: "thread-1",
        currentTitle: "Typed Workbench",
        cwd: "C:/authoritative",
        title: "Preserve overarching titles",
      },
      method: "POST",
      path: "/api/thread-title",
      responseKind: "thread-title",
    });
    for (const status of ["completed", "blocked"] as const) {
      const statusResult = await client.callTool({
        _meta: { threadId: "thread-1" },
        arguments: {},
        name: `task_${status}`,
      });
      assert.equal(statusResult.isError, false);
      assert.deepEqual(executed.at(-1), {
        body: { callerThreadId: "thread-1", cwd: "C:/authoritative", status },
        method: "POST",
        path: "/api/thread-status",
        responseKind: "thread-status",
      });
    }
    assert.ok(server.getReleasedRequestCount() >= 3);
  } finally {
    await projectClient.close();
    await capableClient.close();
    await client.close();
    await server.close();
  }
});

test("child catalogues omit every parent-only tool while retaining child coordination", async () => {
  assert.deepEqual([...WORKBENCH_PARENT_ONLY_TOOLS].sort(), [...EXPECTED_PARENT_ONLY_TOOLS].sort());
  const controller = codexController({
    executeCommand: async () => Response.json({}),
    daemonOrigin: "http://127.0.0.1:4500",
    requestCodex: async request => ({ id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } }),
  });
  const server = await startController(controller);
  const parent = await connectClient(server.url);
  const childUrl = new URL(server.url);
  childUrl.searchParams.set("subagent", "true");
  const child = await connectClient(childUrl);
  try {
    const parentTools = new Set((await parent.listTools()).tools.map(({ name }) => name));
    const childTools = new Set((await child.listTools()).tools.map(({ name }) => name));
    for (const tool of EXPECTED_PARENT_ONLY_TOOLS) {
      assert.equal(parentTools.has(tool), true, `${tool} should remain available to parents`);
      assert.equal(childTools.has(tool), false, `${tool} should be absent for children`);
    }
    for (const tool of ["git_arc_claims", "message", "message_wait", "subagent_dequeue", "subagent_queue"]) {
      assert.equal(childTools.has(tool), true, `${tool} should remain available to children`);
    }
  } finally {
    await Promise.all([parent.close(), child.close()]);
    await server.close();
  }
});

test("stale parent-only tools cannot dispatch for a canonical child caller", async () => {
  let dispatches = 0;
  const controller = codexController({
    ...{ isSubagentCaller: async () => true },
    executeCommand: async () => { dispatches++; return Response.json({}); },
    daemonOrigin: "http://127.0.0.1:4500",
    requestCodex: async request => ({ id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } }),
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const argumentsByTool: Record<(typeof EXPECTED_PARENT_ONLY_TOOLS)[number], Record<string, unknown>> = {
      git_arc_propose: { title: "change files" },
      subagent_create: {
        message: "inspect", name: "mira", profileId: "profile", title: "inspect",
        userVisibleSimpleVersion: "Inspect the requested area.",
      },
      subagent_list: {},
      subagent_profiles: {},
      subagent_settle: { threadIds: ["child"] },
      subagent_stop: { threadIds: ["child"] },
      subagent_wait: { threadIds: ["child"] },
      task_get: {},
      task_set: { title: "change title" },
    };
    for (const name of EXPECTED_PARENT_ONLY_TOOLS) {
      const result = await client.callTool({
        name, arguments: argumentsByTool[name], _meta: { threadId: "child" },
      });
      assert.equal(result.isError, true, `${name} should reject a canonical child caller`);
    }
    assert.equal(dispatches, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("fails closed without trusted identity and sanitizes boundary failures", async () => {
  let codexReadCount = 0;
  let failThreadRead = false;
  const logged: string[] = [];
  const controller = codexController({
    executeCommand: async () => { throw new Error("unexpected execution"); },
    lifecycleLogError: (_name, message) => { logged.push(message); },
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    requestCodex: async () => {
      codexReadCount += 1;
      if (!failThreadRead) return { id: 0, result: { thread: { cwd: "C:/authoritative" } } };
      throw new Error("token=super-secret C:/Users/chiri/private.txt");
    },
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const missingIdentity = await client.callTool({ arguments: {}, name: "task_get" });
    assert.equal(missingIdentity.isError, true);
    assert.match(responseText(missingIdentity), /trusted MCP thread identity/u);
    assert.equal(codexReadCount, 0);

    const missingShellIdentity = await client.callTool({ arguments: { command: "echo no" }, name: "shell" });
    assert.equal(missingShellIdentity.isError, true);
    assert.match(responseText(missingShellIdentity), /trusted MCP thread identity/u);
    assert.equal(codexReadCount, 0);

    failThreadRead = true;
    const sanitized = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {},
      name: "task_get",
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
  const capturedCancellation = deferred<ProviderToolResult>();
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const controller = codexController({
    transcript: {
      start: async input => ({ threadId: String(input.metadata.threadId), turnId: "turn", itemId: "item",
        sourceId: "source", parentId: "parent", tool: input.tool, arguments: input.arguments, startedAt: 1 } as WorkbenchToolTranscriptReference),
      finish: async (reference, result) => {
        if (reference.threadId === "thread-1") capturedCancellation.resolve(result);
      },
    },
    executeCommand: async (request, signal) => await new Promise<Response>((resolve, reject) => {
      const callerThreadId = String(request.body?.callerThreadId ?? "");
      executions.set(callerThreadId, { resolve, signal });
      if (executions.size === 2) bothStarted.resolve();
      signal.addEventListener("abort", () => {
        if (callerThreadId === "thread-1") firstAborted.resolve(signal.reason);
        reject(signal.reason);
      }, { once: true });
    }),
    daemonOrigin: "http://127.0.0.1:4500",
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
      name: "task_get",
    }, undefined, { signal: firstAbort.signal });
    const secondCall = secondClient.callTool({
      _meta: { threadId: "thread-2" },
      arguments: {},
      name: "task_get",
    });
    await bothStarted.promise;
    assert.equal(executions.get("thread-1")?.signal.aborted, false);
    assert.equal(executions.get("thread-2")?.signal.aborted, false);

    firstAbort.abort(new Error("first caller stopped"));
    await assert.rejects(firstCall, /first caller stopped|aborted/u);
    assert.ok(await firstAborted.promise);
    assert.equal((await capturedCancellation.promise).isError, true);
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
  const createController = () => codexController({
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
    daemonOrigin: "http://127.0.0.1:4500",
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

test("MCP returns typed Git status without replacing its readable output", async () => {
  const status = {
    pending: [], accepted: [], dirtyClaims: ["a.ts"], cleanClaims: [], stashedClaims: [],
    unclaimedDirt: [], recovery: [], unavailableRecovery: [],
  };
  const controller = codexController({
    executeCommand: async () => Response.json(status),
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    requestCodex: async (request) => ({ id: request.id ?? null, result: { thread: { cwd: "C:/workspace" } } }),
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const result = await client.callTool({ name: "git_arc_status", arguments: {}, _meta: { threadId: "native-thread" } });
    assert.equal(result.isError, false);
    assert.match(responseText(result), /Dirty claims: a\.ts/u);
    assert.deepEqual(result.structuredContent, {
      kind: "success", version: 1, receipt: null, status: status, changes: [], diff: null,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("keeps declared Code Mode waits alive with request-owned progress only", async () => {
  const executions = new Map<string, (response: Response) => void>();
  const started = deferred<void>();
  const pulses: Array<() => Promise<void>> = [];
  const stopped: string[] = [];
  const progress: number[] = [];
  const progressed = deferred<number>();
  const controller = codexController({
    executeCommand: async request => await new Promise<Response>(resolve => {
      executions.set(request.responseKind, resolve);
      if (executions.size === 2) started.resolve();
    }),
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    requestCodex: async request => ({
      id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } },
    }),
    scheduleProgress: (pulse) => {
      let active = true;
      pulses.push(async () => {
        if (active) await pulse();
      });
      return () => {
        active = false;
        stopped.push("stopped");
      };
    },
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const questionnaire = client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {
        questions: [{ header: "choice", id: "choice", options: [], question: "Which?" }],
      },
      name: "request_user_input",
    }, undefined, {
      onprogress: update => {
        progress.push(update.progress);
        progressed.resolve(update.progress);
      },
      resetTimeoutOnProgress: true,
    });
    const ordinary = client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {},
      name: "task_get",
    }, undefined, {
      onprogress: () => { throw new Error("ordinary tool emitted progress"); },
    });
    await started.promise;
    assert.equal(pulses.length, 1);
    await pulses[0]!();
    assert.equal(await progressed.promise, 1);
    assert.deepEqual(progress, [1]);

    executions.get("thread-title-get")?.(Response.json({ title: "done" }));
    executions.get("json")?.(Response.json({ answers: { choice: { answers: ["one"] } } }));
    assert.equal((await ordinary).isError, false);
    assert.equal((await questionnaire).isError, false);
    assert.deepEqual(stopped, ["stopped"]);
    await pulses[0]!();
    assert.deepEqual(progress, [1]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("outside-sandbox shells keep their stream alive through approval and run with monotonic progress", { timeout: 5_000 }, async () => {
  const cwd = process.cwd();
  const pulses: Array<() => Promise<void>> = [];
  let stopped = 0;
  const progress: number[] = [];
  let progressed = deferred<number>();
  const approvalRequested = deferred<void>();
  const approval = deferred<void>();
  const running = deferred<void>();
  const release = deferred<void>();
  const run = { kind: "sandboxed" as const, label: "pnpm test", expensive: false, request: {
    command: ["pwsh", "-Command", "pnpm test"], cwd, permissions: { type: "disabled" as const },
    windowsSandboxLevel: "disabled" as const, windowsSandboxPrivateDesktop: false, workspaceRoots: [cwd],
  } };
  const tools: WorkbenchProviderTools = {
    caller: async () => ({ harness: "claude", threadId: WorkbenchThreadIdSchema.parse("thread"), cwd }),
    describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: true }),
    patchClaims: async () => "",
    prepareShell: async () => ({ run, cwd, shell: "pwsh" }),
    prepareExecution: async () => run,
  };
  const controller = new WorkbenchAgentMcpController({
    tools: () => tools, daemonOrigin: "http://127.0.0.1:4500", lifecycleLogError: () => {},
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    approveHostedShell: async () => {
      approvalRequested.resolve();
      await approval.promise;
      return { kind: "allowOnce" };
    },
    executeShell: async () => {
      running.resolve();
      await release.promise;
      return { exitCode: 0, stderr: "", stdout: "complete" };
    },
    scheduleProgress: (pulse) => {
      let active = true;
      pulses.push(async () => {
        if (active) await pulse();
      });
      return () => {
        active = false;
        stopped += 1;
      };
    },
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const call = client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { command: "pnpm test", outside_sandbox: true, justification: "test" },
      name: "shell",
    }, undefined, {
      onprogress: update => {
        progress.push(update.progress);
        progressed.resolve(update.progress);
      },
      resetTimeoutOnProgress: true,
    });
    await approvalRequested.promise;
    assert.equal(pulses.length, 1, "the approval wait is kept alive");
    await pulses[0]!();
    assert.equal(await progressed.promise, 1);

    progressed = deferred<number>();
    approval.resolve();
    await running.promise;
    assert.equal(stopped, 1, "the approval keepalive stops before the run takes over");
    assert.equal(pulses.length, 2, "the run is kept alive");
    await pulses[0]!();
    await pulses[1]!();
    assert.equal(await progressed.promise, 2);

    release.resolve();
    const result = await call;
    assert.equal(result.isError, false);
    assert.match(responseText(result), /complete/u);
    assert.equal(stopped, 2);
    await pulses[1]!();
    assert.deepEqual(progress, [1, 2]);
  } finally {
    approval.resolve();
    release.resolve();
    await client.close();
    await server.close();
  }
});

for (const hosted of [false, true]) test(`${hosted ? "hosted" : "native"} shells hold no reload while waiting or running`, { timeout: 5_000 }, async () => {
  const approval = deferred<void>();
  const approvalRequested = deferred<void>();
  const running = deferred<void>();
  // Hosted admission canonicalizes the caller's real working directory.
  const cwd = process.cwd();
  const run = { kind: "sandboxed" as const, label: "pnpm test", expensive: true, request: {
    command: ["pwsh", "-Command", "pnpm test"], cwd, permissions: { type: "disabled" as const },
    windowsSandboxLevel: "disabled" as const, windowsSandboxPrivateDesktop: false, workspaceRoots: [cwd],
  } };
  const tools: WorkbenchProviderTools = {
    caller: async () => ({ harness: "claude", threadId: WorkbenchThreadIdSchema.parse("thread"), cwd }),
    describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: hosted }),
    patchClaims: async () => "",
    prepareShell: async () => ({ run, cwd, shell: "pwsh" }),
    prepareExecution: async () => run,
  };
  const controller = new WorkbenchAgentMcpController({
    tools: () => tools, daemonOrigin: "http://127.0.0.1:4500", lifecycleLogError: () => {},
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    // Running inside the generation's call is exactly what must not happen.
    executeShell: async () => { running.resolve(); return await new Promise<never>(() => {}); },
    approveHostedShell: async () => {
      approvalRequested.resolve();
      await approval.promise;
      return { kind: "allowOnce" };
    },
  });
  const scope = { clientScope: "client", projectLocal: false, provider: "claude", subagent: false };
  const step = controller.call(scope, {
    arguments: { command: "pnpm test", ...(hosted ? { outside_sandbox: true } : {}) },
    detachableShell: true, meta: {}, name: "shell", requestId: 1, signal: new AbortController().signal,
  });
  if (hosted) {
    await approvalRequested.promise;
    assert.deepEqual(controller.listRuntimeDrainPending(), [], "an approval wait holds no reload");
    approval.resolve();
  }
  const settled = await Promise.race([step.then(() => "prepared"), running.promise.then(() => "running")]);
  assert.equal(settled, "prepared", "the command runs outside the generation that prepared it");
  const detached = await step;
  assert.ok(detached.kind === "detached" && detached.call.shell);
  assert.deepEqual(controller.listRuntimeDrainPending(), [], "a running command holds no reload");
  const result = await controller.finish(scope, detached.call, {
    shellResult: { exitCode: 3, stdout: "partial\n", stderr: "denied\n" },
  });
  detached.call.unregister();
  assert.equal(result.isError, false);
  assert.match(responseText(result), /Exit code: 3[\s\S]*partial[\s\S]*denied/u);
  assert.deepEqual(result.structuredContent, {
    cwd, exitCode: 3, shell: detached.call.shell.shell, stderr: "denied\n", stdout: "partial\n",
  });
});

test("a user-stopped shell answers only the stop sentence, found through its Codex call id", async () => {
  let now = 0;
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry(undefined, () => now);
  const errors: string[] = [];
  const recorded: ProviderToolResult[] = [];
  const reference = {
    threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: "turn", itemId: "item",
    sourceId: "source", parentId: "source", tool: "shell", arguments: {}, startedAt: 0,
  } as WorkbenchToolTranscriptReference;
  const tools: WorkbenchProviderTools = {
    caller: async () => ({ harness: "codex", threadId: reference.threadId, cwd: "C:/workspace" }),
    describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: false }),
    patchClaims: async () => "",
    prepareShell: async () => preparedShell("C:/workspace"),
    transcript: { start: async () => reference, finish: async (_reference, result) => { recorded.push(result); } },
  };
  const controller = new WorkbenchAgentMcpController({
    tools: () => tools, daemonOrigin: "http://127.0.0.1:4500", requestRegistry,
    lifecycleLogError: (_name, message) => { errors.push(message); },
    executeShell: async () => await new Promise<never>(() => {}),
  });
  const scope = { clientScope: "client", projectLocal: false, provider: "codex", subagent: false };
  const step = await controller.call(scope, {
    arguments: { command: "pnpm test" }, detachableShell: true, meta: { callId: "call_native", threadId: "native-thread" },
    name: "shell", requestId: 1, signal: new AbortController().signal,
  });
  assert.ok(step.kind === "detached");
  now = 12_000;
  assert.equal(requestRegistry.stopShell(reference.threadId, ["call_native"]), true);
  const result = await controller.finish(scope, step.call, { error: step.call.signal.reason });
  step.call.unregister();
  assert.deepEqual(result, { content: [{ type: "text", text: "The user stopped this command after 12s." }], isError: true });
  assert.deepEqual(recorded[0]?.content, result.content);
  assert.deepEqual(errors, [], "an expected stop is not logged as a failure");
});

test("parallel shells are offered only to a provider that names its calls and an ingress that orders the rest", async () => {
  const describe = (namesCalls: boolean) => new WorkbenchAgentMcpController({
    tools: () => ({
      caller: async () => ({ harness: "claude", threadId: WorkbenchThreadIdSchema.parse("thread"), cwd: "C:/workspace" }),
      describe: async () => ({
        experimental: {}, shellDescription: "test", shellEscalation: true, ...(namesCalls ? { toolUseIdMeta: "key" } : {}),
      }),
      patchClaims: async () => "",
    }),
    daemonOrigin: "http://127.0.0.1:4500", requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
  });
  const shellOf = async (namesCalls: boolean, batchTurns?: boolean) => {
    const scope = { clientScope: "client", projectLocal: false, provider: "claude", subagent: false };
    const listed = await describe(namesCalls).describe(scope, new AbortController().signal, { batchTurns });
    const shell = listed.tools.find(tool => tool.name === "shell")!;
    return { parallel: "parallel" in (shell.inputSchema.properties ?? {}), readOnly: shell.annotations?.readOnlyHint };
  };
  assert.deepEqual(await shellOf(true, true), { parallel: true, readOnly: true });
  assert.deepEqual(await shellOf(true), { parallel: false, readOnly: false }, "an ingress that cannot order shells keeps them serial");
  assert.deepEqual(await shellOf(false, true), { parallel: false, readOnly: false });
});

test("serial shells and mutating wb tools wait their batch turn before they are recorded, and are skipped after a failure", async () => {
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const started: string[] = [];
  const executed: string[] = [];
  const tools: WorkbenchProviderTools = {
    caller: async () => ({ harness: "claude", threadId, cwd: "C:/workspace" }),
    describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: false, toolUseIdMeta: "key" }),
    patchClaims: async () => "",
    prepareShell: async () => preparedShell("C:/workspace"),
    transcript: {
      start: async input => {
        started.push(input.tool);
        return { threadId, turnId: "turn", itemId: `item-${started.length}`, sourceId: "s", parentId: "s", tool: input.tool, arguments: {}, startedAt: 0 } as WorkbenchToolTranscriptReference;
      },
      finish: async () => undefined,
    },
  };
  const controller = new WorkbenchAgentMcpController({
    tools: () => tools, daemonOrigin: "http://127.0.0.1:4500", requestRegistry,
    executeCommand: async request => { executed.push(request.path); return new Response("ok"); },
    executeShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const scope = { clientScope: "client", projectLocal: false, provider: "claude", subagent: false };
  const shellCall = (key: string, args: object, extra: object = {}) => controller.call(scope, {
    arguments: { command: "work", ...args }, detachableShell: true, batchTurns: true, meta: { key },
    name: "shell", requestId: key, signal: new AbortController().signal, ...extra,
  });
  assert.deepEqual(await shellCall("build", {}), { kind: "batchTurn", key: "build", toolName: "shell" });
  assert.deepEqual(started, [], "nothing is recorded or approved before the shell's turn");
  assert.equal((await shellCall("sleep", { parallel: true })).kind, "detached", "a parallel shell starts at once");
  assert.deepEqual(started, ["shell"]);
  assert.equal((await shellCall("unordered", {}, { batchTurns: false })).kind, "detached",
    "an ingress that cannot wait never gets a turn step");

  const skipped = await shellCall("test", {}, { batchTurn: "skipped" });
  assert.ok(skipped.kind === "result");
  assert.equal(skipped.result.isError, true);
  assert.match(responseText(skipped.result), /^Skipped: an earlier call in this batch failed/u);
  assert.deepEqual(started, ["shell", "shell", "shell"], "the skipped shell still shows as a failed row");

  const titleCall = (extra: object = {}) => controller.call(scope, {
    arguments: { title: "renamed" }, batchTurns: true, meta: { key: "title" }, name: "task_set", requestId: "title",
    signal: new AbortController().signal, ...extra,
  });
  assert.deepEqual(await titleCall(), { kind: "batchTurn", key: "title", toolName: "task_set" });
  const title = await titleCall({ batchTurn: "skipped" });
  assert.ok(title.kind === "result");
  assert.match(responseText(title.result), /^Skipped: an earlier call in this batch failed/u);
  assert.deepEqual(executed, [], "a mutating wb tool after a failure never runs");
  const readOnly = await controller.call(scope, {
    arguments: {}, batchTurns: true, meta: { key: "get" }, name: "task_get", requestId: "get", signal: new AbortController().signal,
  });
  assert.equal(readOnly.kind, "result", "read-only wb tools never wait");
});

test("a steer interrupting a queued expensive shell answers only that the command never started", async () => {
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const errors: string[] = [];
  const reference = {
    threadId: WorkbenchThreadIdSchema.parse("thread"), turnId: "turn", itemId: "item",
    sourceId: "source", parentId: "source", tool: "shell", arguments: {}, startedAt: 0,
  } as WorkbenchToolTranscriptReference;
  const tools: WorkbenchProviderTools = {
    caller: async () => ({ harness: "claude", threadId: reference.threadId, cwd: "C:/workspace" }),
    describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: false }),
    patchClaims: async () => "",
    prepareShell: async () => preparedShell("C:/workspace"),
    transcript: { start: async () => reference, finish: async () => undefined },
  };
  const controller = new WorkbenchAgentMcpController({
    tools: () => tools, daemonOrigin: "http://127.0.0.1:4500", requestRegistry,
    lifecycleLogError: (_name, message) => { errors.push(message); },
    executeShell: async () => await new Promise<never>(() => {}),
  });
  const scope = { clientScope: "client", projectLocal: false, provider: "claude", subagent: false };
  const step = await controller.call(scope, {
    arguments: { command: "cargo build", expensive: true }, detachableShell: true, meta: {},
    name: "shell", requestId: 1, signal: new AbortController().signal,
  });
  assert.ok(step.kind === "detached");
  step.call.shellQueue!.queued(0);
  assert.equal(requestRegistry.interruptThreadWaits(reference.threadId), 1);
  const result = await controller.finish(scope, step.call, { error: step.call.signal.reason });
  step.call.unregister();
  assert.equal(result.isError, true, "the row stays a readable failed command");
  assert.match(responseText(result), /^Queued command interrupted before it started/u);
  assert.deepEqual(errors, [], "an expected steer is not logged as a failure");
});

test("thread steer interruption ends declared waits but preserves questionnaires and ordinary MCP calls", { timeout: 5_000 }, async () => {
  const executions = new Map<string, { resolve: (response: Response) => void; signal: AbortSignal }>();
  const allStarted = deferred<void>();
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const workbenchThreadId = WorkbenchThreadIdSchema.parse("97d84a45-0d43-4d20-a996-e6b8bd8ad149");
  const waitStates: Array<{ threadId: string; toolNames: string[] }> = [];
  const stopWaitObservation = requestRegistry.subscribeThreadWaits(({ threadId, toolNames }) => {
    waitStates.push({ threadId, toolNames });
  });
  const controller = codexController({
    resolveThreadId: async (nativeId, cwd) => {
      assert.equal(nativeId, "thread-1");
      assert.equal(cwd, "C:/authoritative");
      return workbenchThreadId;
    },
    executeCommand: async (request, signal) => await new Promise<Response>((resolve) => {
      assert.equal(request.body?.callerThreadId, "97d84a45-0d43-4d20-a996-e6b8bd8ad149");
      executions.set(request.responseKind, { resolve, signal });
      if (executions.size === 3) allStarted.resolve();
      signal.addEventListener("abort", () => resolve(new Response(
        "This expected steer interruption must not reach MCP output.",
        { status: 409 },
      )), { once: true });
    }),
    getReloadScopeCatalog: () => reloadCatalog,
    lifecycleLogError: () => undefined,
    daemonOrigin: "http://127.0.0.1:4500",
    requestCodex: async (request) => ({ id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } }),
    requestRegistry,
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const subagentCall = client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { names: ["momo"] },
      name: "subagent_wait",
    });
    const titleCall = client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {},
      name: "task_get",
    });
    const questionnaireCall = client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: {
        questions: [{ header: "details", id: "details", options: [], question: "What should change?" }],
      },
      name: "request_user_input",
    });
    await allStarted.promise;

    assert.deepEqual(waitStates, [{ threadId: workbenchThreadId, toolNames: ["subagent_wait"] }]);
    assert.equal(requestRegistry.interruptThreadWaits(workbenchThreadId), 1);
    const subagentResult = await subagentCall;
    // An incoming message is expected, not a failure: the agent gets plain text it can act on.
    assert.equal(subagentResult.isError, false);
    assert.match(responseText(subagentResult), /new message arrived/u);
    assert.deepEqual(subagentResult.structuredContent, { kind: "interruptedBySteer", version: 1 });
    assert.equal(executions.get("thread-title-get")?.signal.aborted, false);
    assert.equal(executions.get("json")?.signal.aborted, false);

    executions.get("thread-title-get")?.resolve(Response.json({ title: "still running" }));
    executions.get("json")?.resolve(Response.json({ answers: { details: { answers: ["still waiting"] } } }));
    const titleResult = await titleCall;
    const questionnaireResult = await questionnaireCall;
    assert.equal(titleResult.isError, false);
    assert.match(responseText(titleResult), /still running/u);
    assert.equal(questionnaireResult.isError, false);
    assert.match(responseText(questionnaireResult), /still waiting/u);
  } finally {
    stopWaitObservation();
    requestRegistry.dispose();
    await client.close();
    await server.close();
  }
});

test("a steer during detached wait transcript admission interrupts before command execution", async () => {
  const transcriptStarted = deferred<void>();
  const releaseTranscript = deferred<void>();
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const recorded: ProviderToolResult[] = [];
  const reference = {
    threadId, turnId: "turn", itemId: "item", sourceId: "source", parentId: "parent",
    tool: "subagent_wait", arguments: {}, startedAt: 1,
  } as WorkbenchToolTranscriptReference;
  const tools: WorkbenchProviderTools = {
    caller: async () => ({ harness: "codex", threadId, cwd: "C:/workspace" }),
    describe: async () => ({ experimental: {}, shellDescription: "test", shellEscalation: false }),
    patchClaims: async () => "",
    transcript: {
      start: async () => {
        transcriptStarted.resolve();
        await releaseTranscript.promise;
        return reference;
      },
      finish: async (_reference, result) => { recorded.push(result); },
    },
  };
  const controller = new WorkbenchAgentMcpController({
    tools: () => tools,
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry,
    executeCommand: async () => assert.fail("an interrupted wait must not execute"),
  });
  const call = controller.call(
    { clientScope: "client", projectLocal: true, provider: "codex", subagent: false },
    {
      arguments: { names: ["momo"] },
      detachableShell: true,
      meta: {},
      name: "subagent_wait",
      requestId: 1,
      signal: new AbortController().signal,
    },
  );
  await transcriptStarted.promise;
  requestRegistry.interruptThreadWaits(threadId);
  releaseTranscript.resolve();

  const step = await call;
  assert.equal(step.kind, "result");
  if (step.kind !== "result") return;
  assert.equal(step.result.isError, false);
  assert.deepEqual(step.result.structuredContent, { kind: "interruptedBySteer", version: 1 });
  assert.deepEqual(recorded, [step.result]);
  requestRegistry.dispose();
});

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

test("declared waits survive runtime drain, release their generation and finish through the replacement", { timeout: 5_000 }, async () => {
  const oldStarted = deferred<void>();
  const requestRegistry = new WorkbenchAgentMcpRequestRegistry();
  const oldExecutor = {};
  const replacementExecutor = {};
  let builtRequest: WorkbenchAgentCommandRequest | null = null;
  requestRegistry.activateCommandExecutor(oldExecutor, async (request, signal) => {
    builtRequest = request;
    oldStarted.resolve();
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const createController = () => codexController({
    lifecycleLogError: () => undefined,
    daemonOrigin: "http://127.0.0.1:4500",
    requestCodex: async (request) => ({ id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } }),
    requestRegistry,
  });
  let controller = createController();
  const server = await startController(() => controller);
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

    assert.equal(controller.beginRuntimeDrain(), 0);
    // A reload commits a replacement generation and retires the old one while the wait is still open.
    const replacement = createController();
    replacement.activateToolGeneration();
    controller.releaseRuntimeOwner();
    const retired = new WeakRef(controller);
    controller = replacement;
    for (let pass = 0; pass < 2; pass++) {
      await new Promise<void>(resolve => { setImmediate(resolve); });
      collectGarbage();
    }
    assert.equal(retired.deref(), undefined, "an open wait must not keep its retired MCP generation alive");
    requestRegistry.activateCommandExecutor(replacementExecutor, async (request) => {
      assert.strictEqual(request, builtRequest);
      return new Response("replacement generation completed");
    });
    const result = await oldCall;
    assert.equal(result.isError, false);
    assert.match(responseText(result), /replacement generation completed/u);
  } finally {
    requestRegistry.releaseCommandExecutor(oldExecutor);
    requestRegistry.releaseCommandExecutor(replacementExecutor);
    requestRegistry.dispose();
    await oldClient.close();
    await server.close();
  }
});
