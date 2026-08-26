/*
 * Exports:
 * - No production exports; Node tests cover direct Browse/subagent/thread dispatch, response adaptation, and caller cancellation. Keywords: workbench, agent, command, browse, subagent, thread, cancellation, transport, test.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";

const reloadCatalog = [
  { access: "agent" as const, description: "Core", safeAll: true, scope: "server:core" },
  { access: "agent" as const, description: "MCP", safeAll: true, scope: "server:mcp" },
  { access: "agent" as const, description: "Topology", safeAll: false, scope: "server:topology" },
  { access: "cli" as const, description: "Codex harness", destructive: true, safeAll: false, scope: "harness:codex" },
  { access: "operator" as const, description: "Process", destructive: true, safeAll: false, scope: "server:process" },
];

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function startController(controller: WorkbenchAgentCommandController, onHandled: () => void = () => undefined) {
  const server = http.createServer((request, response) => {
    void controller.handleHttpRequest(request, response).finally(onHandled);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    origin: `http://127.0.0.1:${address.port}`,
  };
}

function agentCommandBody(args: string[]) {
  const body = new URLSearchParams({ cwd: process.cwd() });
  for (const arg of args) body.append("arg", arg);
  return body.toString();
}

function subagentCommandBody(args: string[]) {
  const body = new URLSearchParams(agentCommandBody(args));
  body.set("callerThreadId", "parent-thread");
  return body.toString();
}

function applyPatchHookBody(command: string, sessionId = "parent-thread", callerThreadId: string | null = "parent-thread") {
  const body = new URLSearchParams(agentCommandBody(["__hook", "apply-patch-claim"]));
  if (callerThreadId) body.set("callerThreadId", callerThreadId);
  body.set("callerHarness", "codex");
  body.set("hookInput", JSON.stringify({
    cwd: process.cwd(),
    session_id: sessionId,
    tool_use_id: "patch-one",
    tool_input: { command },
    tool_name: "apply_patch",
    turn_id: "turn-one",
  }));
  return body.toString();
}

function createBrowsePort(executeBrowseRequest: (body: Buffer, signal: AbortSignal) => Promise<Response>) {
  return {
    executeBrowseRequest,
    executeSessionRequest: async () => Response.json({ generatedAt: new Date(0).toISOString(), projectId: null, sessions: [] }),
    getReloadDirt: async () => ({ dirtyScopes: [], error: null, pendingScopes: [] }),
    getReloadScopeCatalog: () => reloadCatalog,
  };
}

test("answers the private apply_patch hook from the active claim owner", async () => {
  const checkedPaths: string[][] = [];
  const checkedThreadIds: string[] = [];
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
      checkApplyPatchClaims: async ({ paths, threadId }) => {
        checkedPaths.push(paths);
        checkedThreadIds.push(threadId);
        return paths.some((filePath) => filePath.endsWith("unclaimed.ts"))
          ? { allowed: false, uncoveredPaths: paths.filter((filePath) => filePath.endsWith("unclaimed.ts")) }
          : { allowed: true, uncoveredPaths: [] };
      },
    },
    async () => { throw new Error("claim denial must not wait on marker transport"); },
  );
  const server = await startController(controller);
  try {
    const request = async (filePath: string) => await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: applyPatchHookBody(`*** Begin Patch\n*** Update File: ${filePath}\n@@\n-old\n+new\n*** End Patch`, "provider-thread", null),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const allowed = await request("claimed.ts");
    assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(await allowed.text()), {});
    const denied = await request("unclaimed.ts");
    assert.equal(denied.status, 200);
    const deniedDecision = JSON.parse(await denied.text()) as {
      additionalContext?: string;
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
      systemMessage: string;
    };
    assert.deepEqual(deniedDecision.hookSpecificOutput, {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `apply_patch denied. No active Git arc claim covers ${checkedPaths[1]![0]}. Claim every path before editing.`,
    });
    assert.equal(deniedDecision.additionalContext, undefined);
    assert.match(deniedDecision.systemMessage, /^workbench:file-change-failure:v1:/u);
    assert.deepEqual(JSON.parse(deniedDecision.systemMessage.replace(/^workbench:file-change-failure:v1:/u, "")), {
      changes: [{
        additions: 1,
        deletions: 1,
        kind: { move_path: null, type: "update" },
        path: checkedPaths[1]![0],
      }],
    });

    const mixed = await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: applyPatchHookBody("*** Begin Patch\n*** Add File: claimed.ts\n+claimed\n*** Add File: unclaimed.ts\n+unclaimed\n*** End Patch", "provider-thread", null),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const mixedDecision = await mixed.json() as { systemMessage: string };
    const mixedPayload = JSON.parse(mixedDecision.systemMessage.replace(/^workbench:file-change-failure:v1:/u, "")) as { changes: Array<{ path: string }> };
    assert.deepEqual(mixedPayload.changes.map((change) => change.path), [checkedPaths[2]![1]]);
    assert.deepEqual(checkedThreadIds, ["provider-thread", "provider-thread", "provider-thread"]);
  } finally {
    await server.close();
  }
});

test("returns Codex deny decisions for mismatched identity, malformed input, and claim-read failure", async () => {
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
      checkApplyPatchClaims: async () => { throw new Error("claim registry unavailable"); },
    },
  );
  const server = await startController(controller);
  try {
    const send = async (body: string) => await fetch(`${server.origin}/orchestrator/agent-command`, {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const mismatch = await send(applyPatchHookBody("*** Begin Patch\n*** Delete File: claimed.ts\n*** End Patch", "different-thread"));
    assert.equal(mismatch.status, 200);
    assert.match((await mismatch.json() as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason, /session_id does not match/u);
    const unavailable = await send(applyPatchHookBody("*** Begin Patch\n*** Delete File: claimed.ts\n*** End Patch"));
    assert.equal(unavailable.status, 200);
    assert.match((await unavailable.json() as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason, /claim registry unavailable/u);
    const malformed = new URLSearchParams(agentCommandBody(["__hook", "apply-patch-claim"]));
    malformed.set("callerHarness", "codex");
    malformed.set("hookInput", "not json");
    const malformedResponse = await send(malformed.toString());
    assert.equal(malformedResponse.status, 200);
    const malformedDecision = await malformedResponse.json() as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(malformedDecision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(malformedDecision.hookSpecificOutput.permissionDecisionReason, /not valid JSON/u);
  } finally {
    await server.close();
  }
});

test("dispatches Browse commands directly without an internal fetch and preserves response adaptation", async () => {
  let receivedBody = "";
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    createBrowsePort(async (body) => {
      receivedBody = body.toString("utf8");
      return Response.json({
        durationMs: 1,
        exitCode: 0,
        ok: true,
        stderr: "",
        stdout: "direct Browse owner\n",
      });
    }),
    async () => { throw new Error("unexpected internal fetch"); },
  );
  const server = await startController(controller);
  try {
    const response = await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: agentCommandBody(["browse", "run", "--thread", "thread-1", "--command", "status"]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "direct Browse owner\n");
    assert.match(receivedBody, /"script":"status"/u);
  } finally {
    await server.close();
  }
});

test("renders complete help without an internal capability request", async () => {
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
    async () => { throw new Error("unexpected internal fetch"); },
  );
  const server = await startController(controller);
  try {
    const response = await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: agentCommandBody(["--help"]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /wb git arc restore/u);
  } finally {
    await server.close();
  }
});

test("dispatches ripgrep directly with one argument-vector request", async () => {
  let received: { input: object; signal: AbortSignal } | null = null;
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
    async () => { throw new Error("unexpected internal fetch"); },
    {
      execute: async (input, signal) => {
        received = { input, signal };
        return new Response("one match\n");
      },
    },
  );
  const server = await startController(controller);
  try {
    const response = await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: agentCommandBody(["rg", "--", "-n", "a pattern with 'quotes'", "webapp"]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "one match\n");
    assert.deepEqual(received?.input, {
      args: ["-n", "a pattern with 'quotes'", "webapp"],
      cwd: process.cwd(),
    });
    assert.equal(received?.signal.aborted, false);
  } finally {
    await server.close();
  }
});

test("dispatches native subagent commands directly without waiting on Next fetch headers", async () => {
  let receivedRequest: { method?: string; params?: unknown } | null = null;
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
      requestSubagent: async (request) => {
        receivedRequest = request;
        return { id: request.id ?? null, result: { profiles: [] } };
      },
    },
    async () => { throw new Error("unexpected internal fetch"); },
  );
  const server = await startController(controller);
  try {
    const response = await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: subagentCommandBody(["subagent", "profiles"]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(await response.text()), { profiles: [] });
    assert.equal(receivedRequest?.method, "workbench/subagent/profiles");
    assert.deepEqual(receivedRequest?.params, {
      action: "profiles",
      callerThreadId: "parent-thread",
      cwd: process.cwd(),
      workbenchOrigin: "http://127.0.0.1:4500",
    });
  } finally {
    await server.close();
  }
});

test("dispatches thread resume through the direct managed-thread transport", async () => {
  let receivedRequest: { method?: string; params?: unknown } | null = null;
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
      requestSubagent: async (request) => {
        receivedRequest = request;
        return { id: request.id ?? null, result: { accepted: true, threadId: "parent-thread", turnId: "turn-one" } };
      },
    },
    async () => { throw new Error("unexpected internal fetch"); },
  );
  const server = await startController(controller);
  try {
    const response = await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: subagentCommandBody(["thread", "resume"]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Thread resume scheduled.\n");
    assert.deepEqual(receivedRequest, {
      id: 0,
      method: "workbench/thread/resume",
      params: { callerThreadId: "parent-thread", cwd: process.cwd() },
    });
  } finally {
    await server.close();
  }
});

test("cancels the exact direct subagent waiter when the native caller disconnects", async () => {
  const waitStarted = deferred<string>();
  const waitCancelled = deferred<string>();
  const waitResponse = deferred<{ id: number | string | null; error: { code: number; message: string } }>();
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
      requestSubagent: async (message) => {
        const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
          ? message.params as Record<string, unknown>
          : {};
        const waitId = String(params.waitId ?? "");
        if (message.method === "workbench/subagent/wait") {
          waitStarted.resolve(waitId);
          return await waitResponse.promise;
        }
        assert.equal(message.method, "workbench/subagent/waitCancel");
        waitCancelled.resolve(waitId);
        waitResponse.resolve({ id: 0, error: { code: -32000, message: "Subagent wait cancelled." } });
        return { id: 0, result: { cancelled: true } };
      },
    },
    async () => { throw new Error("unexpected internal fetch"); },
  );
  const server = await startController(controller);
  try {
    const body = subagentCommandBody(["subagent", "wait", "--id", "child-thread"]);
    const request = http.request(`${server.origin}/orchestrator/agent-command`, {
      headers: {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    request.on("error", () => undefined);
    request.end(body);
    const waitId = await waitStarted.promise;
    assert.ok(waitId);
    request.destroy();
    assert.equal(await waitCancelled.promise, waitId);
  } finally {
    await server.close();
  }
});

test("aborts direct Browse execution when the native caller disconnects", async () => {
  const started = deferred<AbortSignal>();
  const aborted = deferred<Error>();
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    createBrowsePort(async (_body, signal) => {
      started.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = signal.reason instanceof Error ? signal.reason : new Error("aborted");
          aborted.resolve(error);
          reject(error);
        }, { once: true });
      });
    }),
  );
  const server = await startController(controller);
  try {
    const body = agentCommandBody(["browse", "run", "--thread", "thread-1", "--command", "status"]);
    const request = http.request(`${server.origin}/orchestrator/agent-command`, {
      headers: {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    request.on("error", () => undefined);
    request.end(body);
    await started.promise;
    request.destroy();
    assert.match((await aborted.promise).message, /disconnected/u);
  } finally {
    await server.close();
  }
});

test("passes caller cancellation into genuine remaining fetches", async () => {
  const started = deferred<AbortSignal>();
  const aborted = deferred<Error>();
  const fetchRequest: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    started.resolve(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = signal.reason instanceof Error ? signal.reason : new Error("aborted");
        aborted.resolve(error);
        reject(error);
      }, { once: true });
    });
  };
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
    fetchRequest,
  );
  const server = await startController(controller);
  try {
    const body = agentCommandBody(["thread", "recall", "--thread", "thread-1"]);
    const request = http.request(`${server.origin}/orchestrator/agent-command`, {
      headers: {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    request.on("error", () => undefined);
    request.end(body);
    await started.promise;
    request.destroy();
    assert.match((await aborted.promise).message, /disconnected/u);
  } finally {
    await server.close();
  }
});

test("reload admission releases the handler before terminal polling completes", async () => {
  const handled = deferred<void>();
  const pollStarted = deferred<void>();
  const terminal = deferred<Response>();
  const fetchRequest: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") {
      return Response.json({
        appliedScopes: [], completedAt: null, error: null, ok: true,
        queuedScopes: [], requestedScopes: ["server:core"], startedAt: 1, state: "running",
      });
    }
    pollStarted.resolve();
    return await terminal.promise;
  };
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
    fetchRequest,
  );
  const server = await startController(controller, () => handled.resolve());
  try {
    let clientSettled = false;
    const client = fetch(`${server.origin}/orchestrator/agent-command`, {
      body: agentCommandBody(["reload", "--server:core"]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }).then((response) => {
      clientSettled = true;
      return response;
    });

    await handled.promise;
    assert.equal(clientSettled, false);
    await pollStarted.promise;
    controller.beginRuntimeDrain();
    terminal.resolve(Response.json({
      appliedScopes: ["server:core"], completedAt: 2, error: null, ok: true,
      queuedScopes: [], requestedScopes: ["server:core"], startedAt: 1, state: "succeeded",
    }));

    const response = await client;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Reload succeeded.\nApplied: server:core\nQueued: none\n");
  } finally {
    await server.close();
  }
});

test("ordinary command admission releases the handler and runtime drain cancels dirt", async () => {
  const handled = deferred<void>();
  const dirtStarted = deferred<void>();
  const dirtCancelled = deferred<Error>();
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
      getReloadDirt: async (signal) => await new Promise((_, reject) => {
        dirtStarted.resolve();
        signal?.addEventListener("abort", () => {
          const reason = signal.reason instanceof Error ? signal.reason : new Error("missing cancellation reason");
          dirtCancelled.resolve(reason);
          reject(reason);
        }, { once: true });
      }),
    },
  );
  const server = await startController(controller, () => handled.resolve());
  try {
    const client = fetch(`${server.origin}/orchestrator/agent-command`, {
      body: agentCommandBody(["dirt"]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    await dirtStarted.promise;
    await handled.promise;

    controller.beginRuntimeDrain();
    assert.match((await dirtCancelled.promise).message, /user-authorized reload/u);
    const response = await client;
    assert.equal(response.status, 503);
    assert.match(await response.text(), /user-authorized reload/u);
    await controller.dispose();
    assert.deepEqual(controller.listRuntimeDrainPending(), []);
  } finally {
    await server.close();
  }
});

test("caller metadata cannot convert a user reload into managed admission", async () => {
  const requests: Record<string, unknown>[] = [];
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
    },
    async (_input, init) => {
      requests.push(typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {});
      return Response.json({
        appliedScopes: ["server:mcp", "server:topology"], completedAt: 2, error: null, ok: true,
        queuedScopes: [], requestedScopes: ["server:mcp", "server:topology"], startedAt: 1, state: "succeeded",
      });
    },
  );
  const server = await startController(controller);
  try {
    const body = new URLSearchParams(agentCommandBody(["reload", "--server:mcp", "--server:topology"]));
    body.set("callerHarness", "codex");
    body.set("callerThreadId", "thread-one");
    const response = await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Applied: server:mcp, server:topology/u);
    assert.deepEqual(requests, [{ scopes: ["server:mcp", "server:topology"] }]);
  } finally {
    await server.close();
  }
});

test("dirt and all share the live dirt snapshot while unsafe remains explicit", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
      getReloadDirt: async () => ({
        dirtyScopes: [
          { description: "Core", destructive: false, scope: "server:core" },
          { description: "Codex harness", destructive: true, scope: "harness:codex" },
        ],
        error: null,
        pendingScopes: [],
      }),
    },
    async (_input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      requestBodies.push(body);
      const scopes = body.scopes as string[];
      return Response.json({
        appliedScopes: scopes, completedAt: 2, error: null, ok: true,
        queuedScopes: [], requestedScopes: scopes, startedAt: 1, state: "succeeded",
      });
    },
  );
  const server = await startController(controller);
  const run = async (args: string[]) => await fetch(`${server.origin}/orchestrator/agent-command`, {
    body: agentCommandBody(args), headers: { "Content-Type": "application/x-www-form-urlencoded" }, method: "POST",
  });
  try {
    assert.equal(await (await run(["dirt"])).text(), "server:core\nharness:codex\n");
    assert.match(await (await run(["reload", "--all"])).text(), /Applied: server:core/u);
    assert.match(await (await run(["reload", "--all", "--unsafe"])).text(), /Applied: server:core, harness:codex/u);
    assert.deepEqual(requestBodies, [
      { scopes: ["server:core"] },
      { scopes: ["server:core", "harness:codex"] },
    ]);
  } finally {
    await server.close();
  }
});

test("managed hard reloads bypass the direct coordinator", async () => {
  const requests: Array<{ body: Record<string, unknown>; method: string }> = [];
  const fetchRequest: typeof fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push({ body, method });
    if (method === "POST") {
      return Response.json({
        appliedScopes: [], completedAt: null, error: null, ok: true,
        queuedScopes: [], requestedScopes: ["server:process"], startedAt: 1, state: "running",
      });
    }
    return Response.json({
      appliedScopes: ["server:process"], completedAt: 2, error: null, ok: true,
      queuedScopes: [], requestedScopes: ["server:process"], startedAt: 1, state: "succeeded",
    });
  };
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    {
      ...createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
      getReloadScopeCatalog: () => reloadCatalog,
    },
    fetchRequest,
  );
  const server = await startController(controller);
  try {
    const body = new URLSearchParams(agentCommandBody(["reload", "--hard"]));
    body.set("callerThreadId", "thread-one");
    const response = await fetch(`${server.origin}/orchestrator/agent-command`, {
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Applied: server:process/u);
    assert.deepEqual(requests, [
      {
        body: { scopes: ["server:process"] },
        method: "POST",
      },
      { body: {}, method: "GET" },
    ]);
  } finally {
    await server.close();
  }
});

test("disconnecting after reload admission aborts terminal polling", async () => {
  const handled = deferred<void>();
  const pollStarted = deferred<AbortSignal>();
  const aborted = deferred<Error>();
  const fetchRequest: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") {
      return Response.json({
        appliedScopes: [], completedAt: null, error: null, ok: true,
        queuedScopes: [], requestedScopes: ["server:core"], startedAt: 1, state: "running",
      });
    }
    const signal = init?.signal;
    assert.ok(signal);
    pollStarted.resolve(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = signal.reason instanceof Error ? signal.reason : new Error("aborted");
        aborted.resolve(error);
        reject(error);
      }, { once: true });
    });
  };
  const controller = new WorkbenchAgentCommandController(
    "http://127.0.0.1:3002",
    "http://127.0.0.1:4500",
    createBrowsePort(async () => { throw new Error("unexpected Browse dispatch"); }),
    fetchRequest,
  );
  const server = await startController(controller, () => handled.resolve());
  try {
    const body = agentCommandBody(["reload", "--server:core"]);
    const request = http.request(`${server.origin}/orchestrator/agent-command`, {
      headers: {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    request.on("error", () => undefined);
    request.end(body);
    await handled.promise;
    await pollStarted.promise;
    request.destroy();
    assert.match((await aborted.promise).message, /disconnected/u);
  } finally {
    await server.close();
  }
});
