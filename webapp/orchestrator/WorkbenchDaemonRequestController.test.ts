/*
 * Exports:
 * - No production exports; tests protect semantic dispatch, parameter errors, and replaceable Browse ownership. Keywords: daemon, rpc, dispatch, browse, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchDaemonRequestController from "./WorkbenchDaemonRequestController.ts";

function createController(options: { gitArcResponse?: Response; rejectProjectId?: string } = {}) {
  let globalNetworkEnabled = false;
  const projectNetworkOverrides = new Map<string, boolean>();
  const networkWrites: object[] = [];
  const fileWrites: object[] = [];
  const targetReads: object[] = [];
  const targetWrites: object[] = [];
  const controller = new WorkbenchDaemonRequestController({
    agents: {
      listAgents: async () => ({ data: [] }),
      readAgent: async () => ({ codexGlobalDuplicate: false, data: { description: "", name: "", path: "", prompt: "" } }),
      readSkills: async () => ({ data: [], instructionPacks: [], instructions: "" }),
    },
    files: {
      read: async ({ path, projectId }) => ({ content: "", headContent: null, mtimeMs: 1, path, projectId, updatedAt: "" }),
      write: async (request) => {
        fileWrites.push(request);
        return { changes: {}, mtimeMs: 2, path: request.path, projectId: request.projectId, updatedAt: "" };
      },
    },
    gitArc: { executeRequest: async () => options.gitArcResponse ?? Response.json({ ok: true }) },
    nativeFiles: {
      linkRoots: async () => ({ roots: [] }),
      open: async (request) => ({ ok: true, path: request.path, projectId: request.projectId ?? null, target: request.path }),
      reveal: async (request) => ({ ok: true, path: request.path, projectId: request.projectId }),
    },
    codexSandboxNetwork: {
      read: async (projectId) => {
        const projectOverride = projectNetworkOverrides.get(projectId) ?? null;
        return {
          effectiveEnabled: projectOverride ?? globalNetworkEnabled,
          globalEnabled: globalNetworkEnabled,
          projectId,
          projectOverride,
        };
      },
      setGlobal: async (enabled) => {
        networkWrites.push({ enabled, scope: "global" });
        globalNetworkEnabled = enabled;
      },
      setProjectOverride: async (projectId, enabled) => {
        networkWrites.push({ enabled, projectId, scope: "project" });
        if (enabled === null) projectNetworkOverrides.delete(projectId);
        else projectNetworkOverrides.set(projectId, enabled);
      },
    },
    profiles: {
      mutate: async () => ({ profiles: [] }),
      read: async () => ({ profiles: [] }),
    },
    profileTargets: {
      readComposerProfileTarget: async (slot) => {
        targetReads.push(slot);
        return null;
      },
      setComposerProfileTarget: async (slot, selection) => {
        targetWrites.push({ selection, slot });
        return true;
      },
    },
    projects: {
      readCatalog: async () => ({ data: [], rootPath: "" }),
      resolveProjectById: async (projectId) => {
        if (projectId === options.rejectProjectId) throw new Error("Unknown project.");
        return { id: projectId, kind: "git", root: "", rootPath: "", roots: [] };
      },
    },
    settings: {
      readLocalCapabilities: async () => ({ browseRawCommandsEnabled: false }),
      updateLocalCapabilities: async (update) => update({ browseRawCommandsEnabled: false }),
    },
  });
  return { controller, fileWrites, networkWrites, targetReads, targetWrites };
}

test("dispatch validates semantic parameters without corrupting valid empty file content", async () => {
  const { controller, fileWrites } = createController();
  const invalid = await controller.handle({
    id: 1,
    method: "project/file/save",
    params: { content: "", path: "note.md", projectId: "project" },
  });
  assert.equal(invalid.error?.code, -32602);
  assert.equal(fileWrites.length, 0);

  const valid = await controller.handle({
    id: 2,
    method: "project/file/save",
    params: { content: "", expectedMtimeMs: 1, path: "note.md", projectId: "project" },
  });
  assert.equal(valid.error, undefined);
  assert.deepEqual(fileWrites, [{
    content: "",
    expectedMtimeMs: 1,
    force: false,
    path: "note.md",
    projectId: "project",
    resetToHead: false,
  }]);
});

test("Browse registration swaps atomically and stale disposal cannot remove its replacement", async () => {
  const { controller } = createController();
  assert.match(
    (await controller.handle({ id: 1, method: "browse/sessions/read", params: {} })).error?.message ?? "",
    /reloading/u,
  );

  const removeFirst = controller.registerBrowse({
    controlSession: async () => ({ owner: "first" }),
    listSessions: async () => ({ owner: "first" }),
  });
  const removeSecond = controller.registerBrowse({
    controlSession: async () => ({ owner: "second" }),
    listSessions: async () => ({ owner: "second" }),
  });
  removeFirst();
  assert.deepEqual(
    (await controller.handle({ id: 2, method: "browse/sessions/read", params: {} })).result,
    { owner: "second" },
  );
  removeSecond();
  assert.match(
    (await controller.handle({ id: 3, method: "browse/sessions/read", params: {} })).error?.message ?? "",
    /reloading/u,
  );
});

test("Codex sandbox network requests validate project ownership and preserve explicit override intent", async () => {
  const { controller, networkWrites } = createController({ rejectProjectId: "missing" });
  const rejected = await controller.handle({
    id: 1,
    method: "codex-sandbox-network/update",
    params: { enabled: true, projectId: "missing", scope: "project" },
  });
  assert.match(rejected.error?.message ?? "", /Unknown project/u);
  assert.deepEqual(networkWrites, []);

  const global = await controller.handle({
    id: 2,
    method: "codex-sandbox-network/update",
    params: { enabled: true, projectId: "project", scope: "global" },
  });
  assert.deepEqual(global.result, {
    codexSandboxNetwork: {
      effectiveEnabled: true,
      globalEnabled: true,
      projectId: "project",
      projectOverride: null,
    },
  });

  const disabled = await controller.handle({
    id: 3,
    method: "codex-sandbox-network/update",
    params: { enabled: false, projectId: "project", scope: "project" },
  });
  assert.equal((disabled.result as { codexSandboxNetwork: { effectiveEnabled: boolean } }).codexSandboxNetwork.effectiveEnabled, false);

  const inherited = await controller.handle({
    id: 4,
    method: "codex-sandbox-network/update",
    params: { enabled: null, projectId: "project", scope: "project" },
  });
  assert.equal((inherited.result as { codexSandboxNetwork: { effectiveEnabled: boolean } }).codexSandboxNetwork.effectiveEnabled, true);
  assert.deepEqual(networkWrites, [
    { enabled: true, scope: "global" },
    { enabled: false, projectId: "project", scope: "project" },
    { enabled: null, projectId: "project", scope: "project" },
  ]);
});

test("profile target dispatch preserves exact slot and settings contracts", async () => {
  const { controller, targetReads, targetWrites } = createController();
  const slot = { draftId: "draft", harness: "codex", kind: "draft", projectId: "project" };
  const selection = {
    kind: "profile",
    profileId: "profile",
    settings: {
      agentPath: "library:agents/lily.md",
      agentSource: "library",
      harness: "codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "fast",
    },
  };

  assert.deepEqual(
    (await controller.handle({ id: 1, method: "profiles/target/read", params: { slot } })).result,
    { selection: null },
  );
  assert.deepEqual(
    (await controller.handle({ id: 2, method: "profiles/target/set", params: { selection, slot } })).result,
    { ok: true },
  );
  assert.deepEqual(targetReads, [slot]);
  assert.deepEqual(targetWrites, [{ selection, slot }]);
  assert.equal(
    (await controller.handle({
      id: 3,
      method: "profiles/target/set",
      params: { selection: { kind: "custom", settings: {} }, slot },
    })).error?.code,
    -32602,
  );
});

test("Browse control action comes from the semantic method", async () => {
  const { controller } = createController();
  const controls: object[] = [];
  controller.registerBrowse({
    controlSession: async (params) => {
      controls.push(params);
      return { ok: true };
    },
    listSessions: async () => ({ sessions: [] }),
  });

  await controller.handle({ id: 1, method: "browse/sessions/stop", params: { session: "one" } });
  await controller.handle({ id: 2, method: "browse/sessions/forget", params: { session: "two" } });
  assert.deepEqual(controls, [
    { action: "stop", session: "one" },
    { action: "forget", session: "two" },
  ]);
});

test("Git arc dispatch returns domain data and preserves structured failure data", async () => {
  const comparison = {
    changes: [],
    checkpointCommit: "a".repeat(40),
    checkpointRef: "refs/workbench/arc",
    intentName: "typed Git request",
    repoRoot: "C:/git/web/workbench",
    scopePaths: ["webapp"],
  };
  const success = createController({ gitArcResponse: Response.json(comparison) }).controller;
  assert.deepEqual(
    (await success.handle({ id: 1, method: "git/arc/compare", params: {} })).result,
    comparison,
  );

  const gitArcFailure = {
    action: "compare",
    code: "operationRejected",
    message: "Comparison was rejected.",
    version: 1,
  };
  const rejected = createController({
    gitArcResponse: Response.json(
      { error: "Comparison was rejected.", gitArcFailure },
      { status: 409 },
    ),
  }).controller;
  assert.deepEqual(
    (await rejected.handle({ id: 2, method: "git/arc/compare", params: {} })).error?.data,
    { gitArcFailure },
  );
});
