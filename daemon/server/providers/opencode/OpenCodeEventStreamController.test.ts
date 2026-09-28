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
const started = { type: "session.execution.started", data: { sessionID: "session" }, id: "started",
  durable: { aggregateID: "session", seq: 1, version: 1 } } as OpenCodeEvent;

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
  assert.deepEqual(await firstBaseline.promise, { changed: true, unrelated: false });
  await firstEvent.promise;
  firstEnd.resolve();
  retry.resolve();
  await secondConnected.promise;
  assert.equal(connections, 2);
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
