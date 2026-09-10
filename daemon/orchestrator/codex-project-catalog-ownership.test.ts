/*
 * No production exports. Node tests protect current feature and project-catalog ownership across a stable Codex bridge.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type CodexAppServer from "./CodexAppServer";
import CodexStdioBridge from "./CodexStdioBridge";
import type { JsonRpcRequest } from "./bridge-types";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

function createResolution(projectId: string, cwd: string): AgentEndpointProjectResolution {
  const rootPath = `C:/projects/${projectId}`;
  return {
    cwd,
    project: {
      id: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId),
      kind: "git",
      root: rootPath,
      rootPath,
      roots: [{ id: projectId, name: projectId, root: rootPath, rootPath }],
    },
    root: { id: projectId, name: projectId, root: rootPath, rootPath },
  };
}

function createThread(cwd: string): Thread {
  return {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: null,
    cliVersion: "test",
    createdAt: 1,
    cwd,
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "legacy",
    id: "thread-1",
    modelProvider: "openai",
    model: null,
    projectId: null,
    reasoningEffort: null,
    name: null,
    parentThreadId: null,
    path: null,
    preview: "",
    recencyAt: null,
    section: null,
    sectionEnteredAt: null,
    sessionId: "session-1",
    source: "appServer",
    status: { type: "idle" },
    threadSource: null,
    turns: [],
    updatedAt: 2,
  };
}

async function createThreadReadHarness(
  resolveProjectFromCwd: (cwd: string | null | undefined) => Promise<AgentEndpointProjectResolution>,
) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-thread-recall-"));
  const sentRequests: JsonRpcRequest[] = [];
  let bridge!: CodexStdioBridge;
  const appServer = {
    send(message: JsonRpcRequest) {
      sentRequests.push(message);
      setImmediate(() => {
        void bridge.handleUpstreamMessage({
          id: message.id ?? null,
          result: { thread: createThread("C:/projects/alpha") },
        });
      });
    },
  } as unknown as CodexAppServer;
  bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:4500",
    handleWorkbenchRequest: async (request) => ({ id: request.id ?? null, error: { code: -32000, message: "Unexpected Workbench request." } }),
    onNotification: () => undefined,
    resolveProjectFromCwd,
    sendToClient: () => undefined,
    storageRoot,
  });
  return { bridge, sentRequests, storageRoot };
}

test("stable Codex bridge delegates subagent requests through the current feature owner", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-project-catalog-"));
  const delegatedTo: string[] = [];
  let currentOwner = "alpha";
  const bridge = new CodexStdioBridge({
    appServer: { send: () => undefined } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:4500",
    handleWorkbenchRequest: async (request) => {
      delegatedTo.push(currentOwner);
      return { id: request.id ?? null, result: { owner: currentOwner } };
    },
    onNotification: () => undefined,
    resolveProjectFromCwd: async (cwd) => createResolution(currentOwner, cwd ?? "C:/projects/alpha"),
    sendToClient: () => undefined,
    storageRoot,
  });

  const first = await bridge.handleBridgeRequest({ id: "before-reload", method: "workbench/subagent/list", params: { cwd: "C:/projects/alpha" } });
  currentOwner = "beta";
  const second = await bridge.handleBridgeRequest({ id: "after-reload", method: "workbench/subagent/list", params: { cwd: "C:/projects/beta" } });

  assert.deepEqual(delegatedTo, ["alpha", "beta"]);
  assert.deepEqual([first?.result, second?.result], [{ owner: "alpha" }, { owner: "beta" }]);
  await bridge.disposeImmediately();
});

test("Thread Recall preflights current catalog ownership before legacy-full hydration", async () => {
  const resolvedBy: string[] = [];
  let currentOwner = "alpha";
  const harness = await createThreadReadHarness(async (cwd) => {
    assert.ok(cwd);
    resolvedBy.push(currentOwner);
    return createResolution(currentOwner, cwd);
  });

  const firstResponse = await harness.bridge.handleBridgeRequest({
    id: "first",
    method: "thread/context/read",
    params: { includeTurns: true, threadId: "thread-1", workbenchReadScope: "threadRecall" },
    workbenchThreadHydration: { mode: "legacyFull" },
  });
  currentOwner = "beta";
  const secondResponse = await harness.bridge.handleBridgeRequest({
    id: "second",
    method: "thread/context/read",
    params: { includeTurns: true, threadId: "thread-1", workbenchReadScope: "threadRecall" },
    workbenchThreadHydration: { mode: "legacyFull" },
  });

  assert.equal(firstResponse?.error, undefined);
  assert.equal(secondResponse?.error, undefined);
  assert.deepEqual(resolvedBy, ["alpha", "beta"]);
  assert.deepEqual(harness.sentRequests.map((request) => request.params), [
    { includeTurns: false, threadId: "thread-1" },
    { includeTurns: true, threadId: "thread-1" },
    { includeTurns: false, threadId: "thread-1" },
    { includeTurns: true, threadId: "thread-1" },
  ]);
  await harness.bridge.dispose();
  await fs.rm(harness.storageRoot, { force: true, recursive: true });
});

test("failed Thread Recall ownership validation prevents the legacy-full read", async () => {
  const harness = await createThreadReadHarness(async () => { throw new Error("Thread Recall cwd is unknown."); });

  const response = await harness.bridge.handleBridgeRequest({
    id: "denied",
    method: "thread/context/read",
    params: { includeTurns: true, threadId: "thread-1", workbenchReadScope: "threadRecall" },
    workbenchThreadHydration: { mode: "legacyFull" },
  });

  assert.match(response?.error?.message ?? "", /cwd is unknown/u);
  assert.deepEqual(harness.sentRequests.map((request) => request.params), [
    { includeTurns: false, threadId: "thread-1" },
  ]);
  await harness.bridge.dispose();
  await fs.rm(harness.storageRoot, { force: true, recursive: true });
});
