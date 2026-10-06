/*
 * No production exports. Tests protect OpenCode stream recovery, snapshot fencing, and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCodeEvent } from "@opencode/client";
import OpenCodeEventStreamController from "./OpenCodeEventStreamController";

const connected = { type: "server.connected", data: {}, id: "connected" } as OpenCodeEvent;
const busy = { type: "session.status", data: { sessionID: "session", status: { type: "busy" } }, id: "busy" } as OpenCodeEvent;
const unrelatedStatus = { type: "session.status", data: { sessionID: "unrelated", status: { type: "busy" } }, id: "other" } as OpenCodeEvent;
const usage = { type: "session.usage.updated", data: {
  sessionID: "usage-session", cost: 0,
  tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}, id: "usage" } as OpenCodeEvent;
const started = { type: "session.execution.started", data: { sessionID: "session" }, id: "started",
  durable: { aggregateID: "session", seq: 1, version: 1 } } as OpenCodeEvent;

test("connection readiness waits for reconciliation and retires on disconnect", async () => {
  const baseline = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const end = Promise.withResolvers<void>();
  const retry = Promise.withResolvers<void>();
  const controller = new OpenCodeEventStreamController({
    subscribe: () => ({
      async *[Symbol.asyncIterator]() { yield connected; await end.promise; },
    }),
    onConnected: async () => { entered.resolve(); await baseline.promise; },
    onEvent: async () => {},
    waitBeforeRetry: signal => new Promise<void>(resolve => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      retry.resolve();
    }),
    warn: () => {},
  });
  let ready = false;
  const work = controller.waitForConnection(new AbortController().signal).then(signal => {
    ready = true;
    return signal;
  });
  await entered.promise;
  assert.equal(ready, false);
  baseline.resolve();
  const connection = await work;
  assert.equal(connection.aborted, false);
  end.resolve();
  await retry.promise;
  assert.equal(connection.aborted, true);
  await controller.dispose();
});

test("failed connection, caller cancellation and disposal reject readiness without leaking waiters", async () => {
  for (const cause of ["connection", "caller", "disposal"] as const) {
    const end = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    const caller = new AbortController();
    const controller = new OpenCodeEventStreamController({
      subscribe: signal => ({
        async *[Symbol.asyncIterator]() {
          await Promise.race([end.promise, new Promise<void>(resolve => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          })]);
        },
      }),
      onConnected: async () => {},
      onEvent: async () => {},
      waitBeforeRetry: signal => new Promise<void>(resolve => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        retry.resolve();
      }),
      warn: () => {},
    });
    const rejected = assert.rejects(controller.waitForConnection(caller.signal));
    if (cause === "connection") { end.resolve(); await retry.promise; }
    else if (cause === "caller") caller.abort(new Error("caller stopped"));
    else await controller.dispose();
    await rejected;
    await controller.dispose();
    assert.equal(controller.hasPendingWork(), false);
  }
});

test("reconnects an ended daemon event stream and fences a connection snapshot behind newer session events", async () => {
  const firstEnd = Promise.withResolvers<void>();
  const baselineRelease = Promise.withResolvers<void>();
  const firstEvent = Promise.withResolvers<void>();
  const firstQueued = Promise.withResolvers<void>();
  const firstBaseline = Promise.withResolvers<{ changed: boolean; unrelated: boolean }>();
  const secondConnected = Promise.withResolvers<void>();
  const retry = Promise.withResolvers<void>();
  let connections = 0;
  const controller = new OpenCodeEventStreamController({
    subscribe: signal => {
      connections++;
      if (connections === 1) return {
        async *[Symbol.asyncIterator]() {
          yield connected;
          yield busy;
          yield unrelatedStatus;
          yield started;
          firstQueued.resolve();
          await firstEnd.promise;
        },
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield connected;
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      };
    },
    onEvent: async event => { if (event.type === "session.execution.started") firstEvent.resolve(); },
    onConnected: async ({ wasTouched }) => {
      if (connections === 1) {
        await baselineRelease.promise;
        firstBaseline.resolve({ changed: wasTouched("session"), unrelated: wasTouched("unrelated") });
      } else secondConnected.resolve();
    },
    waitBeforeRetry: async () => { await retry.promise; },
    warn: () => {},
  });
  controller.start();
  assert.equal(connections, 1);
  await firstQueued.promise;
  baselineRelease.resolve();
  assert.deepEqual(await firstBaseline.promise, { changed: true, unrelated: true });
  await firstEvent.promise;
  firstEnd.resolve();
  retry.resolve();
  await secondConnected.promise;
  assert.equal(connections, 2);
  await controller.dispose();
});

test("ephemeral status and usage events fence an older connection activity snapshot", async () => {
  const baselineRelease = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<{ busy: boolean; usage: boolean }>();
  const controller = new OpenCodeEventStreamController({
    subscribe: signal => ({
      async *[Symbol.asyncIterator]() {
        yield connected;
        yield busy;
        yield usage;
        queued.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    }),
    onEvent: async () => {},
    onConnected: async ({ wasTouched }) => {
      await baselineRelease.promise;
      observed.resolve({ busy: wasTouched("session"), usage: wasTouched("usage-session") });
    },
    waitBeforeRetry: async () => {},
    warn: () => {},
  });
  controller.start();
  await queued.promise;
  baselineRelease.resolve();
  assert.deepEqual(await observed.promise, { busy: true, usage: true });
  await controller.dispose();
});

test("event reconciliation failure reconnects instead of leaving a dead subscription", async () => {
  let connections = 0;
  const reconnected = Promise.withResolvers<void>();
  const warnings: string[] = [];
  const controller = new OpenCodeEventStreamController({
    subscribe: signal => ({
      async *[Symbol.asyncIterator]() {
        connections++;
        yield connected;
        if (connections === 1) yield busy;
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    }),
    onConnected: async () => { if (connections === 2) reconnected.resolve(); },
    onEvent: async () => { throw new Error("private event payload"); },
    waitBeforeRetry: async () => {},
    warn: message => { warnings.push(message); },
  });
  controller.start();
  await reconnected.promise;
  assert.equal(connections, 2);
  assert.ok(warnings.some(message => message.includes("event reconciliation failed")));
  assert.equal(warnings.some(message => message.includes("private event payload")), false);
  await controller.dispose();
});
