/*
 * Exports:
 * - No production exports; Node tests cover direct Browse/subagent/thread dispatch, response adaptation, and caller cancellation. Keywords: workbench, agent, command, browse, subagent, thread, cancellation, transport, test.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";

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

function createBrowsePort(executeBrowseRequest: (body: Buffer, signal: AbortSignal) => Promise<Response>) {
  return {
    executeBrowseRequest,
    executeSessionRequest: async () => Response.json({ generatedAt: new Date(0).toISOString(), projectId: null, sessions: [] }),
  };
}

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
        queuedScopes: [], requestedScopes: ["orchestrator-logic"], startedAt: 1, state: "running",
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
      body: agentCommandBody(["orchestrator", "reload", "--orchestrator-logic"]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }).then((response) => {
      clientSettled = true;
      return response;
    });

    await handled.promise;
    assert.equal(clientSettled, false);
    await pollStarted.promise;
    terminal.resolve(Response.json({
      appliedScopes: ["orchestrator-logic"], completedAt: 2, error: null, ok: true,
      queuedScopes: [], requestedScopes: ["orchestrator-logic"], startedAt: 1, state: "succeeded",
    }));

    const response = await client;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Reload succeeded.\nApplied: orchestrator-logic\nQueued: none\n");
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
        queuedScopes: [], requestedScopes: ["orchestrator-logic"], startedAt: 1, state: "running",
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
    const body = agentCommandBody(["orchestrator", "reload", "--orchestrator-logic"]);
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
