/* No production exports. Tests protect reloadable HTTP route dispatch, method matching, fallback responses, and bounded controller failures. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import WorkbenchOrchestratorHttpRouter, { type WorkbenchOrchestratorHttpRouterOptions } from "./WorkbenchOrchestratorHttpRouter";

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
  return new WorkbenchOrchestratorHttpRouter({
    agentCommand: controller("agent"),
    bridgeRequest: controller("bridge"),
    gitArc: controller("git-arc"),
    legacyMigrationSource: controller("migration"),
    mcp: controller("mcp"),
    projectCatalog: controller("projects"),
    projectSnapshot,
    threadGit: controller("thread-git"),
  } satisfies WorkbenchOrchestratorHttpRouterOptions);
}

test("routes every reloadable HTTP controller and preserves method gates", async () => {
  const events: string[] = [];
  const router = createRouter(events);
  for (const [url, method, expected] of [
    ["/orchestrator/agent-command", "POST", "agent"],
    ["/orchestrator/mcp", "POST", "mcp"],
    ["/orchestrator/bridge-request", "POST", "bridge"],
    ["/orchestrator/git-arc", "POST", "git-arc"],
    ["/orchestrator/thread-git", "POST", "thread-git"],
    ["/orchestrator/legacy-migration-source", "DELETE", "migration"],
    ["/orchestrator/projects", "GET", "projects"],
    ["/orchestrator/tree", "POST", "tree"],
  ] as const) {
    const output = response();
    await router.handleHttpRequest(request(url, method), output);
    assert.equal((output as unknown as TestResponse).body, expected);
  }
  assert.deepEqual(events, ["agent", "mcp", "bridge", "git-arc", "thread-git", "migration", "projects", "tree"]);

  const rejected = response();
  await router.handleHttpRequest(request("/orchestrator/projects", "POST"), rejected);
  assert.equal(rejected.statusCode, 404);
  assert.deepEqual(JSON.parse((rejected as unknown as TestResponse).body), { error: "Not found" });
});

test("turns controller failures into bounded HTTP errors", async () => {
  const router = createRouter([], "/orchestrator/bridge-request");
  const output = response();
  await router.handleHttpRequest(request("/orchestrator/bridge-request", "POST"), output);
  assert.equal(output.statusCode, 500);
  assert.deepEqual(JSON.parse((output as unknown as TestResponse).body), { error: "controller exploded" });
});
