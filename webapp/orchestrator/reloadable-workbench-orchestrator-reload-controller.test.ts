/*
 * No production exports. Node tests protect coordinator self-reload state handoff and failure recovery. Keywords: reload, coordinator, generation, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrchestratorReloadScope } from "../lib/types";
import ReloadableWorkbenchOrchestratorReloadController from "./ReloadableWorkbenchOrchestratorReloadController";
import WorkbenchOrchestratorReloadController from "./WorkbenchOrchestratorReloadController";

test("coordinator self-reload executes other scopes first and completes through fresh code", async () => {
  const executed: OrchestratorReloadScope[][] = [];
  let reloads = 0;
  class FreshController extends WorkbenchOrchestratorReloadController {}
  const boundary = new ReloadableWorkbenchOrchestratorReloadController({
    executeScopes: async (scopes) => { executed.push(scopes); },
    listClaims: async () => [{
      harness: "codex",
      lifecycleKind: "working",
      reloadScopes: ["orchestrator-logic", "reload-coordinator"],
      threadId: "caller",
    }],
    loader: {
      load: () => WorkbenchOrchestratorReloadController,
      reload: () => { reloads += 1; return FreshController; },
    },
  });

  const response = await boundary.request({
    cwd: "C:/workbench",
    harness: "codex",
    scopes: ["orchestrator-logic", "reload-coordinator"],
    threadId: "caller",
  }, new AbortController().signal);
  assert.equal(response.state, "succeeded");
  assert.equal(reloads, 1);
  assert.deepEqual(executed, [["orchestrator-logic"]]);
});

test("failed coordinator replacement restores the previous generation and rejects its waiter", async () => {
  let reloads = 0;
  const boundary = new ReloadableWorkbenchOrchestratorReloadController({
    executeScopes: async () => undefined,
    listClaims: async () => [{
      harness: "codex",
      lifecycleKind: "working",
      reloadScopes: ["reload-coordinator"],
      threadId: "caller",
    }],
    loader: {
      load: () => WorkbenchOrchestratorReloadController,
      reload: () => { reloads += 1; throw new Error("fresh module failed"); },
    },
  });

  await assert.rejects(boundary.request({
    cwd: "C:/workbench",
    harness: "codex",
    scopes: ["reload-coordinator"],
    threadId: "caller",
  }, new AbortController().signal), /fresh module failed/u);
  assert.equal(reloads, 1);
});
