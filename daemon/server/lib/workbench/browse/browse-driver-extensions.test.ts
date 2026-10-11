/*
 * Exports:
 * - No production exports; Node tests cover Workbench's Browse driver boundary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import {
  extractSnapshotSubtree,
  formatRuntimeException,
  patchBrowseDriverCommandSchema,
  patchBrowseDriverExtensions,
} from "./browse-driver-extensions.mjs";

interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

function createTouchManager(failOnTouchMove = false) {
  const cdpCalls: CdpCall[] = [];
  class FakeManager {
    async activePage() {
      return {
        sendCDP: async (method: string, params: Record<string, unknown>) => {
          cdpCalls.push({ method, params });
          if (failOnTouchMove && method === "Input.dispatchTouchEvent" && params.type === "touchMove") {
            throw new Error("touch move failed");
          }
          return {};
        },
      };
    }
    async close() {}
    async execute(command: string, _params?: object) {
      return { command };
    }
  }
  patchBrowseDriverExtensions({ DriverSessionManager: FakeManager });
  return { cdpCalls, manager: new FakeManager() };
}

function touchEvents(cdpCalls: CdpCall[]) {
  return cdpCalls
    .filter(({ method }) => method === "Input.dispatchTouchEvent")
    .map(({ params }) => params);
}

class FakeCdpSession {
  private readonly handlers = new Map<string, Set<(params?: object) => void>>();

  emit(event: string, params?: object) {
    for (const handler of this.handlers.get(event) ?? []) handler(params);
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }

  off(event: string, handler: (params?: object) => void) {
    this.handlers.get(event)?.delete(handler);
  }

  on(event: string, handler: (params?: object) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }
}

test("admits Workbench commands through the upstream closed command schema", () => {
  const DriverCommandNameSchema = z.enum(["open"]);
  patchBrowseDriverCommandSchema({ DriverCommandNameSchema });
  assert.equal(DriverCommandNameSchema.parse("workbench.initScript"), "workbench.initScript");
  assert.throws(() => DriverCommandNameSchema.parse("workbench.notReal"));
});

test("extracts one snapshot subtree without retaining siblings", () => {
  const tree = [
    "- document",
    "  - navigation [0-1]",
    "    - link \"home\" [0-2]",
    "  - main [0-3]",
    "    - button \"save\" [0-4]",
  ].join("\n");
  assert.equal(extractSnapshotSubtree(tree, "0-1"), [
    "- navigation [0-1]",
    "  - link \"home\" [0-2]",
  ].join("\n"));
});

test("prefers actionable page exception detail over generic uncaught text", () => {
  assert.equal(formatRuntimeException({
    exception: { description: "ReferenceError: navigation is not defined\n  at <anonymous>:1:1" },
    text: "Uncaught",
  }), "ReferenceError: navigation is not defined\n  at <anonymous>:1:1");
});

test("batches wheel input and parks the pointer in one driver command", async () => {
  const cdpCalls: Array<{ method: string; params: object }> = [];
  class FakeManager {
    calls = 0;
    async activePage() {
      return {
        sendCDP: async (method: string, params: object) => {
          cdpCalls.push({ method, params });
          return {};
        },
      };
    }
    async close() {}
    async execute(command: string, _params?: object) {
      this.calls += 1;
      return { command, scrolled: true };
    }
  }
  patchBrowseDriverExtensions({ DriverSessionManager: FakeManager });
  const manager = new FakeManager();
  const result = await manager.execute("mouse.scroll", {
    deltaX: 0,
    deltaY: -300,
    intervalMs: 0,
    park: true,
    repeat: 3,
    x: 195,
    y: 500,
  });
  assert.equal(manager.calls, 3);
  assert.deepEqual(result, { command: "mouse.scroll", parked: true, repeat: 3, scrolled: true });
  assert.deepEqual(cdpCalls, [{
    method: "Input.dispatchMouseEvent",
    params: { type: "mouseMoved", x: -1, y: -1 },
  }]);
});

test("dispatches repeated touch drags after the requested interval", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { cdpCalls, manager } = createTouchManager();
  const execution = manager.execute("workbench.touchScroll", {
    deltaX: 0,
    deltaY: -300,
    fling: false,
    intervalMs: 25,
    repeat: 2,
    speed: 600,
    x: 200,
    y: 500,
  });
  await new Promise(setImmediate);

  const firstGesture = touchEvents(cdpCalls);
  assert.equal(firstGesture[0]?.type, "touchStart");
  assert.equal(firstGesture.at(-1)?.type, "touchEnd");
  assert.equal(firstGesture.filter(({ type }) => type === "touchStart").length, 1);
  context.mock.timers.tick(24);
  await new Promise(setImmediate);
  assert.equal(touchEvents(cdpCalls).filter(({ type }) => type === "touchStart").length, 1);

  context.mock.timers.tick(1);
  const result = await execution;
  const events = touchEvents(cdpCalls);
  assert.equal(events.filter(({ type }) => type === "touchStart").length, 2);
  assert.equal(events.filter(({ type }) => type === "touchEnd").length, 2);
  const firstMoves = events
    .slice(1, events.findIndex(({ type }, index) => index > 0 && type === "touchEnd"))
    .filter(({ type }) => type === "touchMove");
  assert.ok(firstMoves.length > 1);
  assert.deepEqual(firstMoves.at(-1)?.touchPoints, [{ x: 200, y: 800 }]);
  assert.deepEqual(result, {
    fling: false,
    frames: firstMoves.length,
    repeat: 2,
  });
});

test("adds an accelerated final move only for fling gestures", async () => {
  const regular = createTouchManager();
  await regular.manager.execute("workbench.touchScroll", {
    deltaX: 0,
    deltaY: -300,
    fling: false,
    intervalMs: 0,
    repeat: 1,
    speed: 600,
    x: 200,
    y: 500,
  });
  const fling = createTouchManager();
  const result = await fling.manager.execute("workbench.touchScroll", {
    deltaX: 0,
    deltaY: -300,
    fling: true,
    intervalMs: 0,
    repeat: 1,
    speed: 600,
    x: 200,
    y: 500,
  });
  const regularMoves = touchEvents(regular.cdpCalls).filter(({ type }) => type === "touchMove");
  const flingMoves = touchEvents(fling.cdpCalls).filter(({ type }) => type === "touchMove");
  assert.equal(flingMoves.length, regularMoves.length + 1);
  assert.deepEqual(flingMoves.at(-2)?.touchPoints, [{ x: 200, y: 800 }]);
  assert.deepEqual(flingMoves.at(-1)?.touchPoints, [{ x: 200, y: 875 }]);
  assert.deepEqual(result, {
    fling: true,
    frames: flingMoves.length,
    repeat: 1,
  });
});

test("cancels an active touch gesture and propagates move failures", async () => {
  const { cdpCalls, manager } = createTouchManager(true);
  await assert.rejects(manager.execute("workbench.touchScroll", {
    deltaX: 0,
    deltaY: -300,
    fling: false,
    intervalMs: 0,
    repeat: 1,
    speed: 600,
    x: 200,
    y: 500,
  }), /touch move failed/);
  const events = touchEvents(cdpCalls);
  assert.equal(events[0]?.type, "touchStart");
  assert.deepEqual(events.at(-1), { touchPoints: [], type: "touchCancel" });
  assert.equal(events.some(({ type }) => type === "touchEnd"), false);
});

test("summarizes traces and removes listeners when stopped", async () => {
  const session = new FakeCdpSession();
  class FakeManager {
    async activePage() {
      return {
        mainSession: session,
        sendCDP: async (method: string) => {
          if (method === "Tracing.end") {
            session.emit("Tracing.dataCollected", { value: [{ name: "Layout" }, { name: "Layout" }, { name: "Paint" }] });
            session.emit("Tracing.tracingComplete");
          }
          return {};
        },
      };
    }
    async close() {}
    async execute(command: string, _params?: object) {
      return { command };
    }
  }
  patchBrowseDriverExtensions({ DriverSessionManager: FakeManager });
  const manager = new FakeManager();
  await manager.execute("workbench.trace", { operation: "start" });
  const result = await manager.execute("workbench.trace", { operation: "stop" });
  assert.deepEqual(result, {
    eventCount: 3,
    events: { Layout: 2, Paint: 1 },
    tracing: false,
    truncatedEventNames: false,
  });
  assert.equal(session.listenerCount("Tracing.dataCollected"), 0);
});

test("removes trace listeners when trace completion fails", async () => {
  const session = new FakeCdpSession();
  class FakeManager {
    async activePage() {
      return {
        mainSession: session,
        sendCDP: async (method: string) => {
          if (method === "Tracing.end") throw new Error("trace end failed");
          return {};
        },
      };
    }
    async close() {}
    async execute(command: string, _params?: object) {
      return { command };
    }
  }
  patchBrowseDriverExtensions({ DriverSessionManager: FakeManager });
  const manager = new FakeManager();
  await manager.execute("workbench.trace", { operation: "start" });
  await assert.rejects(
    manager.execute("workbench.trace", { operation: "stop" }),
    /trace end failed/,
  );
  assert.equal(session.listenerCount("Tracing.dataCollected"), 0);
  assert.equal(session.listenerCount("Tracing.tracingComplete"), 0);
});

test("removes trace listeners when trace start fails", async () => {
  const session = new FakeCdpSession();
  class FakeManager {
    async activePage() {
      return {
        mainSession: session,
        sendCDP: async (method: string) => {
          if (method === "Tracing.start") throw new Error("trace start failed");
          return {};
        },
      };
    }
    async close() {}
    async execute(command: string, _params?: object) {
      return { command };
    }
  }
  patchBrowseDriverExtensions({ DriverSessionManager: FakeManager });
  const manager = new FakeManager();
  await assert.rejects(
    manager.execute("workbench.trace", { operation: "start" }),
    /trace start failed/,
  );
  assert.equal(session.listenerCount("Tracing.dataCollected"), 0);
  await assert.rejects(
    manager.execute("workbench.trace", { operation: "stop" }),
    /No trace is running/,
  );
});
