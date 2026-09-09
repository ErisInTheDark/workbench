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

function runtimeOwner(stopAsync = async () => {}, retirePrevious = async () => {}) {
  let deliver!: (message: unknown) => void;
  const appServer = { stopAsync, retirePrevious } as unknown as CodexAppServer;
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

test("shutdown requests current and predecessor process retirement before waiting for either", async () => {
  const previous = deferred();
  const current = deferred();
  let previousStarted = false;
  let currentStarted = false;
  const { runtime } = runtimeOwner(
    async () => { currentStarted = true; await current.promise; },
    async () => { previousStarted = true; await previous.promise; },
  );
  const stopping = runtime.stop();
  try {
    assert.equal(previousStarted, true);
    assert.equal(currentStarted, true);
  } finally {
    previous.resolve();
    current.resolve();
    await stopping;
  }
});

test("shutdown retains failures from both current and predecessor retirement", async () => {
  const current = new Error("current retirement failed");
  const previous = new Error("previous retirement failed");
  const { runtime } = runtimeOwner(
    async () => { throw current; },
    async () => { throw previous; },
  );
  await assert.rejects(runtime.stop(), error => error instanceof AggregateError
    && error.errors.includes(current) && error.errors.includes(previous));
});

test("process retirement is not held hostage by an old message handler", async () => {
  let stopped = false;
  const { deliver, runtime } = runtimeOwner(async () => { stopped = true; });
  const entered = deferred();
  const release = deferred();
  runtime.attachBridge({
    async handleUpstreamMessage() { entered.resolve(); await release.promise; },
  } as unknown as CodexStdioBridge);
  deliver("old message");
  await entered.promise;
  const stopping = runtime.stop();
  try {
    assert.equal(stopped, true);
  } finally {
    release.resolve();
    await stopping;
  }
});

test("expired handoff keeps queued ingress private until the replacement is committed", async () => {
  const { deliver, runtime } = runtimeOwner();
  const entered = deferred();
  const release = deferred();
  const received = deferred();
  const messages: unknown[] = [];
  const oldBridge = {
    async prepareForReload() {},
    async waitForIdle() {},
    expireForReload() {},
    async handleUpstreamMessage() { entered.resolve(); await release.promise; },
    async detachForReload() { return { pendingResponses: new Map() }; },
    async retireAfterHandoff() {},
    resumeAfterReloadFailure() {},
  } as unknown as CodexStdioBridge;
  const replacement = {
    async handleUpstreamMessage(message: unknown) { messages.push(message); received.resolve(); },
  } as unknown as CodexStdioBridge;
  runtime.attachBridge(oldBridge);
  deliver("old read");
  await entered.promise;
  try {
    const handoff = runtime.beginBridgeHandoff(oldBridge);
    handoff.expire();
    await handoff.detach();
    runtime.attachBridge(replacement, { publish: false });
    deliver("queued fact");
    await Promise.resolve();
    assert.deepEqual(messages, []);
    await handoff.commit();
    runtime.attachBridge(replacement);
    await received.promise;
    assert.deepEqual(messages, ["queued fact"]);
  } finally {
    release.resolve();
    await runtime.stop();
  }
});

test("a late detach cannot clear a different attached bridge", async () => {
  const { deliver, runtime } = runtimeOwner();
  const entered = deferred();
  const release = deferred();
  const delivered = deferred();
  const oldBridge = {
    async prepareForReload() {},
    async detachForReload() { entered.resolve(); await release.promise; return { pendingResponses: new Map() }; },
    resumeAfterReloadFailure() {},
  } as unknown as CodexStdioBridge;
  runtime.attachBridge(oldBridge);
  const detaching = runtime.detachBridge(oldBridge);
  await entered.promise;
  runtime.attachBridge({ async handleUpstreamMessage() { delivered.resolve(); } } as unknown as CodexStdioBridge);
  release.resolve();
  await detaching;
  assert.equal(runtime.isAvailable(), true);
  deliver("new message");
  await delivered.promise;
});

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
