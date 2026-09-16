/* No production exports. Tests protect reloadable HTTP route dispatch, project icon routing, method matching, fallback responses, and bounded controller failures. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  return { method, url } as import("node:http").IncomingMessage;
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
    bridgeRequest: controller("bridge"),
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
    ["/daemon/bridge-request", "POST", "bridge"],
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
  assert.deepEqual(events, ["agent", "mcp", "bridge", "git-arc", "thread-git", "projects", "project-icon", "tree", "transcript-assets"]);

  const rejected = response();
  await router.handleHttpRequest(request("/daemon/projects", "POST"), rejected);
  assert.equal(rejected.statusCode, 404);
  assert.deepEqual(JSON.parse((rejected as unknown as TestResponse).body), { error: "Not found" });

  const rejectedIcon = response();
  await router.handleHttpRequest(request("/daemon/project-icons/team%2Falpha", "POST"), rejectedIcon);
  assert.equal(rejectedIcon.statusCode, 404);
});

test("turns controller failures into bounded HTTP errors", async () => {
  const router = createRouter([], "/daemon/bridge-request");
  const output = response();
  await router.handleHttpRequest(request("/daemon/bridge-request", "POST"), output);
  assert.equal(output.statusCode, 500);
  assert.deepEqual(JSON.parse((output as unknown as TestResponse).body), { error: "controller exploded" });
});
