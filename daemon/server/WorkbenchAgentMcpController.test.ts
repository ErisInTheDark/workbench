/* No exports. Tests cover typed MCP inventory, trusted identity, dispatch, waits, and cancellation. */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { listWorkbenchAgentCommands } from "./lib/workbench/commands/workbench-agent-command-registry";
import type { WorkbenchAgentCommandRequest } from "./lib/workbench/commands/workbench-agent-command-definition";
import WorkbenchAgentMcpController, { type WorkbenchAgentMcpControllerOptions } from "./WorkbenchAgentMcpController";
import CodexToolsController from "./CodexToolsController";
import CodexShellController from "./CodexShellController";
import CodexCommandExecController from "./CodexCommandExecController";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { NativeThreadId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { WorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import { WORKBENCH_SHELL_SANDBOX_CAPABILITY } from "./CodexShellController";
import { parseGitArcFailureReceipt } from "workbench-shared/workbench/git/git-arc-failures";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchProviderTools, ProviderToolResult, WorkbenchToolTranscriptReference } from "workbench-shared/workbench/provider/provider-execution";

for (const name of ["task_get", "shell"]) {
  test(`captures complete ${name} results before replying`, async () => {
    const order: string[] = [];
    const results: ProviderToolResult[] = [];
    const reference = { threadId: "thread", turnId: "original-turn", itemId: "item",
      sourceId: "child", parentId: "parent", tool: name, arguments: {}, startedAt: 1 } as WorkbenchToolTranscriptReference;
    const tools: WorkbenchProviderTools = {
      caller: async () => ({ harness: "opencode", threadId: reference.threadId, cwd: "C:/workspace" }),
      describe: async () => ({ experimental: {}, shellDescription: "test" }),
      patchClaims: async () => "",
      shell: async () => {
        order.push("execute");
        return { cwd: "C:/workspace", shell: "pwsh", exitCode: 3, stdout: "complete stdout", stderr: "complete stderr" };
      },
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
      describe: async () => ({ experimental: {}, shellDescription: "test" }),
      patchClaims: unused, shell: unused,
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
  shell?: Pick<CodexShellController, "execute">;
}) {
  const tools = new CodexToolsController({
    resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
    commandExec: new CodexCommandExecController({ requestCodex: options.requestCodex }),
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
    shell: options.shell ?? new CodexShellController({
      readConfiguration: async () => ({ config: {} }),
      executor: { execute: async () => { throw new Error("unexpected shell execution"); } },
    }),
  });
  if (options.transcript) Object.assign(tools, { transcript: options.transcript });
  return new WorkbenchAgentMcpController({
    ...options,
    tools: provider => {
      assert.equal(provider, "codex");
      return tools;
    },
  });
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
      ["git_arc_propose", { amend: true, replace: "proposal-one" }, "conflictingProposalTargets"],
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
    assert.ok(failure && "rejection" in failure);
    assert.deepEqual(failure.rejection, { reason: "missingActiveArc" });
    assert.equal(dispatches, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

for (const failResolution of [false, true]) test(`shell resolves caller identity from thread cwd with resolution failure=${failResolution}`, async () => {
  const identities: object[] = [];
  const controller = codexController({
    executeCommand: async () => Response.json({}),
    daemonOrigin: "http://127.0.0.1:4500",
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    lifecycleLogError: () => {},
    requestCodex: async (request) => {
      assert.equal(request.method, "thread/read");
      assert.deepEqual(request.params, { includeTurns: false, threadId: "native-session" });
      return { id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } };
    },
    resolveThreadId: async (nativeThreadId, cwd) => {
      assert.equal(nativeThreadId, "native-session");
      assert.equal(cwd, "C:/authoritative");
      if (failResolution) throw new Error("identity unavailable");
      return WorkbenchThreadIdSchema.parse("workbench-thread");
    },
    shell: {
      execute: async (_input, _meta, _signal, identity) => {
        identities.push(identity);
        return { cwd: "C:/other", exitCode: 0, shell: "pwsh", stderr: "", stdout: "" };
      },
    },
  });
  const server = await startController(controller);
  const client = await connectClient(server.url);
  try {
    const call = () => client.callTool({
      name: "shell",
      _meta: { threadId: "native-session" },
      arguments: { command: "Get-Location", workdir: "C:/other" },
    });
    assert.equal((await call()).isError, failResolution);
    assert.deepEqual(identities, failResolution ? [] : [{ nativeThreadId: "native-session", workbenchThreadId: "workbench-thread" }]);
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
        describe: async () => ({ experimental: {}, shellDescription: "sandboxed execution" }),
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

test("lists one typed tool per eligible command and dispatches with trusted thread cwd", async () => {
  const executed: WorkbenchAgentCommandRequest[] = [];
  const codexRequests: Array<{ method?: string; params?: unknown }> = [];
  const loggedCommands: Array<{ label: string; succeeded: boolean }> = [];
  const shellCalls: Array<{ input: object; meta: Record<string, unknown> | undefined }> = [];
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
    runLoggedCommand: async (label, _signal, operation, succeeded) => {
      const result = await operation();
      loggedCommands.push({ label, succeeded: succeeded?.(result) ?? true });
      return result;
    },
    shell: {
      execute: async (input, meta) => {
        shellCalls.push({ input, meta });
        return { cwd: "C:/authoritative/child", exitCode: 3, shell: "pwsh", stderr: "sandbox denial\n", stdout: "partial\n" };
      },
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
    const eligible = listWorkbenchAgentCommands(reloadCatalog, "agent").filter(({ hideFromMcp, managedThreadRootOnly }) => !hideFromMcp && !managedThreadRootOnly);
    assert.equal(inventory.tools.length, eligible.length + 1);
    assert.ok(client.getServerCapabilities()?.experimental?.[WORKBENCH_SHELL_SANDBOX_CAPABILITY]);
    assert.equal(inventory.tools.some(({ name }) => name === "browse_raw"), false);
    assert.equal(inventory.tools.some(({ name }) => name === "tokens"), true);
    assert.equal(inventory.tools.some(({ name }) => name === "tokens_project"), true);
    assert.equal(inventory.tools.some(({ name }) => name === "tokens_instructions"), false);
    assert.equal(inventory.tools.some(({ name }) => name === "message"), true);
    assert.equal(inventory.tools.some(({ name }) => name === "subagent_message"), true);
    assert.equal((await projectClient.listTools()).tools.some(({ name }) => name === "tokens_instructions"), true);
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
      "amend", "amendProposalId", "description", "freshDescription", "freshTitle", "paths", "replace", "replaceProposalId", "rootId", "title",
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
    assert.deepEqual(Object.keys(shell.inputSchema.properties ?? {}).sort(), ["command", "login", "timeout_ms", "workdir"]);
    assert.deepEqual(Object.keys(shell.outputSchema?.properties ?? {}).sort(), ["cwd", "exitCode", "shell", "stderr", "stdout"]);
    assert.match(shell.description ?? "", /never escalates.*direct shell_command/u);

    const shellMeta = {
      [WORKBENCH_SHELL_SANDBOX_CAPABILITY]: { effective: "sandbox" },
      threadId: "thread-1",
    };
    const shellResult = await client.callTool({
      _meta: shellMeta,
      arguments: { command: "Get-ChildItem", workdir: "child" },
      name: "shell",
    });
    assert.equal(shellResult.isError, false);
    assert.match(responseText(shellResult), /Exit code: 3[\s\S]*partial[\s\S]*sandbox denial/u);
    assert.deepEqual(shellResult.structuredContent, {
      cwd: "C:/authoritative/child",
      exitCode: 3,
      shell: "pwsh",
      stderr: "sandbox denial\n",
      stdout: "partial\n",
    });
    assert.deepEqual(shellCalls, [{ input: { command: "Get-ChildItem", workdir: "child" }, meta: shellMeta }]);
    assert.deepEqual(loggedCommands, [{ label: "wb shell", succeeded: false }]);

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
    assert.deepEqual(Object.keys(release.inputSchema.properties ?? {}), ["disown"]);
    assert.match(release.description ?? "", /Release clean claims owned by this thread/u);
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
      arguments: { model: "gpt-5-test" },
      name: "tokens_instructions",
    });
    assert.equal(instructionTokens.isError, false);
    assert.deepEqual(executed.at(-1), {
      body: { callerThreadId: "thread-1", cwd: "C:/authoritative", kind: "instructions", model: "gpt-5-test" },
      method: "POST",
      path: "/internal/tokens",
      responseKind: "native",
    });

    const projectTokens = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { model: "gpt-5-test" },
      name: "tokens_project",
    });
    assert.equal(projectTokens.isError, false);
    assert.deepEqual(executed.at(-1), {
      body: { cwd: "C:/authoritative", kind: "projectInstructions", model: "gpt-5-test" },
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
    const missingSandboxState = await client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { command: "echo no" },
      name: "shell",
    });
    assert.equal(missingSandboxState.isError, true);
    assert.match(responseText(missingSandboxState), /valid MCP sandbox state/u);

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

test("shell calls that request progress keep their stream alive", { timeout: 5_000 }, async () => {
  const pulses: Array<() => Promise<void>> = [];
  const stopped: string[] = [];
  const progress: number[] = [];
  const progressed = deferred<number>();
  const started = deferred<void>();
  const release = deferred<void>();
  const controller = codexController({
    executeCommand: async () => new Response("unused"),
    daemonOrigin: "http://127.0.0.1:4500",
    lifecycleLogError: () => {},
    requestRegistry: new WorkbenchAgentMcpRequestRegistry(),
    requestCodex: async request => ({ id: request.id ?? null, result: { thread: { cwd: "C:/workspace" } } }),
    shell: {
      execute: async () => {
        started.resolve();
        await release.promise;
        return { cwd: "C:/workspace", exitCode: 0, shell: "pwsh", stderr: "", stdout: "complete" };
      },
    },
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
    const call = client.callTool({
      _meta: { threadId: "thread-1" },
      arguments: { command: "pnpm test:lifecycle" },
      name: "shell",
    }, undefined, {
      onprogress: update => {
        progress.push(update.progress);
        progressed.resolve(update.progress);
      },
      resetTimeoutOnProgress: true,
    });
    await started.promise;
    assert.equal(pulses.length, 1);
    await pulses[0]!();
    assert.equal(await progressed.promise, 1);
    release.resolve();
    const result = await call;
    assert.equal(result.isError, false);
    assert.match(responseText(result), /complete/u);
    assert.deepEqual(stopped, ["stopped"]);
    await pulses[0]!();
    assert.deepEqual(progress, [1]);
  } finally {
    release.resolve();
    await client.close();
    await server.close();
  }
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
    assert.equal(subagentResult.isError, true);
    assert.equal(responseText(subagentResult), "");
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

test("declared waits survive runtime drain and finish through the replacement command generation", { timeout: 5_000 }, async () => {
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
  const controller = codexController({
    executeCommand: async (request, signal) => await requestRegistry.executeCommand(request, signal),
    lifecycleLogError: () => undefined,
    daemonOrigin: "http://127.0.0.1:4500",
    requestCodex: async (request) => ({ id: request.id ?? null, result: { thread: { cwd: "C:/authoritative" } } }),
    requestRegistry,
  });
  const server = await startController(controller);
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
