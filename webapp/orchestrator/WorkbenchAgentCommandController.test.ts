/*
 * Exports:
 * - No production exports; Node tests cover direct Browse dispatch, response adaptation, and caller cancellation. Keywords: workbench, agent, command, browse, cancellation, transport, test.
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

async function startController(controller: WorkbenchAgentCommandController) {
  const server = http.createServer((request, response) => {
    void controller.handleHttpRequest(request, response);
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
    const body = agentCommandBody(["subagent", "profiles"]);
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
