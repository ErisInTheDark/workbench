/*
 * No production exports. Node tests protect pre-gate page-read draining, during-handoff ingress, and failed-reload reopening. Keywords: codex, app-server, bridge, reload, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type CodexAppServer from "./CodexAppServer";
import CodexAppServerRuntime from "./CodexAppServerRuntime";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";

function deferred<TValue = void>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function runtimeOwner() {
  let deliver!: (message: unknown) => void;
  const appServer = { stopAsync: async () => undefined } as unknown as CodexAppServer;
  const context = {
    codexAppServerOptions: {
      logError() {},
      projectRoot: "C:/repo",
    },
    onCodexFatalExit() {},
  } as unknown as OrchestratorProcessContext;
  const runtime = new CodexAppServerRuntime(context, {
    createAppServer(options) {
      deliver = options.onMessage;
      return appServer;
    },
  });
  return { deliver: (message: unknown) => deliver(message), runtime };
}

test("page reads drain before the upstream handoff gate closes", async () => {
  const { deliver, runtime } = runtimeOwner();
  const prepare = deferred();
  const detachStarted = deferred();
  const finishDetach = deferred();
  const oldDelivered = deferred();
  const newDelivered = deferred();
  const oldMessages: unknown[] = [];
  const newMessages: unknown[] = [];
  const oldBridge = {
    async prepareForReload() { await prepare.promise; },
    async detachForReload() {
      detachStarted.resolve();
      await finishDetach.promise;
      return { pendingResponses: new Map() };
    },
    async handleUpstreamMessage(message: unknown) {
      oldMessages.push(message);
      oldDelivered.resolve();
    },
    resumeAfterReloadFailure() {},
  } as unknown as CodexStdioBridge;
  const newBridge = {
    async handleUpstreamMessage(message: unknown) {
      newMessages.push(message);
      newDelivered.resolve();
    },
  } as unknown as CodexStdioBridge;
  runtime.attachBridge(oldBridge);

  const detach = runtime.detachBridge(oldBridge);
  deliver("during-page-drain");
  await oldDelivered.promise;
  assert.deepEqual(oldMessages, ["during-page-drain"]);

  prepare.resolve();
  await detachStarted.promise;
  deliver("during-handoff");
  await Promise.resolve();
  assert.deepEqual(oldMessages, ["during-page-drain"]);
  finishDetach.resolve();
  await detach;
  runtime.attachBridge(newBridge);
  await newDelivered.promise;
  assert.deepEqual(newMessages, ["during-handoff"]);
});

test("failed bridge detach reopens page reads before releasing the old runtime", async () => {
  const { runtime } = runtimeOwner();
  const events: string[] = [];
  const bridge = {
    async prepareForReload() { events.push("prepare"); },
    async detachForReload() {
      events.push("detach");
      throw new Error("reload failed");
    },
    resumeAfterReloadFailure() { events.push("resume"); },
  } as unknown as CodexStdioBridge;
  runtime.attachBridge(bridge);

  await assert.rejects(runtime.detachBridge(bridge), /reload failed/u);
  assert.deepEqual(events, ["prepare", "detach", "resume"]);
  assert.equal(runtime.isAvailable(), true);
  assert.equal(runtime.isTransitioning(), false);
});
