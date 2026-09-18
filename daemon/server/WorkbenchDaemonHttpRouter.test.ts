/* No production exports. Tests protect reloadable HTTP route dispatch, project icon routing, method matching, fallback responses, and bounded controller failures. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import WorkbenchDaemonHttpRouter, { type WorkbenchDaemonHttpRouterOptions } from "./WorkbenchDaemonHttpRouter";

class TestResponse extends EventEmitter {
  body = "";
  destroyed = false;
  headers = new Map<string, string>();
  headersSent = false;
  statusCode = 200;
  writableEnded = false;

  end(value = "") {
    this.body += String(value);
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }
}

function request(url: string, method: string) {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
  return { method, url, socket } as import("node:http").IncomingMessage;
}

function response() {
  return new TestResponse() as unknown as import("node:http").ServerResponse;
}

function createRouter(events: string[], failurePath: string | null = null) {
  const controller = (label: string) => ({
    handleHttpRequest: async (input: import("node:http").IncomingMessage, output: import("node:http").ServerResponse) => {
      if (input.url === failurePath) throw new Error("controller exploded");
      events.push(label);
      output.end(label);
    },
  });
  const projectSnapshot = {
    handleTreeHttpRequest: async (_input: import("node:http").IncomingMessage, output: import("node:http").ServerResponse) => {
      events.push("tree");
      output.end("tree");
    },
  };
  const projects = controller("projects");
  return new WorkbenchDaemonHttpRouter({
    agentCommand: controller("agent"),
    gitArc: controller("git-arc"),
    mcp: controller("mcp"),
    projectCatalog: {
      ...projects,
      handleIconHttpRequest: controller("project-icon").handleHttpRequest,
    },
    projectSnapshot,
    threadGit: controller("thread-git"),
    transcriptAssets: controller("transcript-assets"),
  } satisfies WorkbenchDaemonHttpRouterOptions);
}

test("routes every reloadable HTTP controller and preserves method gates", async () => {
  const events: string[] = [];
  const router = createRouter(events);
  for (const [url, method, expected] of [
    ["/daemon/agent-command", "POST", "agent"],
    ["/daemon/mcp", "POST", "mcp"],
    ["/daemon/git-arc", "POST", "git-arc"],
    ["/daemon/thread-git", "POST", "thread-git"],
    ["/daemon/projects", "GET", "projects"],
    ["/daemon/project-icons/team%2Falpha", "GET", "project-icon"],
    ["/daemon/tree", "POST", "tree"],
    [`/daemon/transcript-assets/codex/dGhyZWFk/${"a".repeat(64)}.png`, "GET", "transcript-assets"],
  ] as const) {
    const output = response();
    await router.handleHttpRequest(request(url, method), output);
    assert.equal((output as unknown as TestResponse).body, expected);
  }
  assert.deepEqual(events, ["agent", "mcp", "git-arc", "thread-git", "projects", "project-icon", "tree", "transcript-assets"]);

  const rejected = response();
  await router.handleHttpRequest(request("/daemon/projects", "POST"), rejected);
  assert.equal(rejected.statusCode, 404);
  assert.deepEqual(JSON.parse((rejected as unknown as TestResponse).body), { error: "Not found" });

  const rejectedIcon = response();
  await router.handleHttpRequest(request("/daemon/project-icons/team%2Falpha", "POST"), rejectedIcon);
  assert.equal(rejectedIcon.statusCode, 404);
});

test("turns controller failures into bounded HTTP errors", async () => {
  const router = createRouter([], "/daemon/agent-command");
  const output = response();
  await router.handleHttpRequest(request("/daemon/agent-command", "POST"), output);
  assert.equal(output.statusCode, 500);
  assert.deepEqual(JSON.parse((output as unknown as TestResponse).body), { error: "controller exploded" });
});

test("rejects LAN requests before invoking daemon controllers", async () => {
  const events: string[] = [];
  const router = createRouter(events);
  const input = request("/daemon/projects", "GET");
  Object.defineProperty(input.socket, "remoteAddress", { value: "192.168.1.50", configurable: true });
  input.headers = { host: "127.0.0.1", "x-forwarded-for": "127.0.0.1" };
  const output = response();
  await router.handleHttpRequest(input, output);
  assert.equal(output.statusCode, 403);
  assert.deepEqual(events, []);
});

test("WebSocket upgrades reject non-loopback peers before switching protocols despite forged local headers", async context => {
  const router = createRouter([]);
  let peer = "192.168.1.50";
  const server = createServer();
  server.on("upgrade", (input, socket) => {
    Object.defineProperty(input.socket, "remoteAddress", { value: peer, configurable: true });
    void router.admitUpgrade(input).then(admitted => {
      if (admitted) socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    });
  });
  context.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const upgrade = () => new Promise<number>((resolve, reject) => {
    const input = httpRequest(`http://127.0.0.1:${address.port}/`, { headers: {
      Connection: "Upgrade", Upgrade: "websocket", Host: "localhost", "X-Forwarded-For": "127.0.0.1",
    } });
    input.on("error", reject);
    input.on("response", output => { output.resume(); resolve(output.statusCode!); });
    input.on("upgrade", (output, socket) => { socket.destroy(); resolve(output.statusCode!); });
    input.end();
  });
  assert.equal(await upgrade(), 403);
  peer = "127.0.0.1";
  assert.equal(await upgrade(), 101);
});
