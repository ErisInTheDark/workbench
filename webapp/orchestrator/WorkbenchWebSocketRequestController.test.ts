/*
 * Exports:
 * - No production exports; Node tests protect WebSocket pending warnings, terminal completion, handoff, socket isolation, and send failures. Keywords: websocket, latency, timer, handoff, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BridgeClient, JsonRpcRequest } from "./bridge-types";
import WorkbenchWebSocketRequestController, { type WorkbenchWebSocketRequestControllerOptions } from "./WorkbenchWebSocketRequestController";

class FakeClock {
  nowMs = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };

  readonly setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, dueAt: this.nowMs + Math.max(0, delayMs) });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  advance(durationMs: number) {
    const target = this.nowMs + durationMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.nowMs = next[1].dueAt;
      next[1].callback();
    }
    this.nowMs = target;
  }
}

function createClient(send: BridgeClient["send"] = (_data, callback) => callback?.()): BridgeClient {
  return {
    OPEN: 1,
    close() {},
    on() {},
    once() {},
    readyState: 1,
    send,
  };
}

function createController(options: {
  clock: FakeClock;
  initialState?: WorkbenchWebSocketRequestControllerOptions["initialState"];
  lines?: string[];
  onDisconnect?: (connectionId: string) => void;
  onHarnessMessage?: (message: JsonRpcRequest, client: BridgeClient) => Promise<void> | void;
}) {
  const lines = options.lines ?? [];
  const controller = new WorkbenchWebSocketRequestController({
    clearTimeout: options.clock.clearTimeout,
    harnesses: {
      handleBrowserMessage: async (_harness, message, client) => await options.onHarnessMessage?.(message, client),
      resolveHarness: (value, resolveOptions) => {
        if ((value === undefined || value === null || value === "") && resolveOptions?.defaultToCodex) return "codex";
        if (value === "codex" || value === "copilot" || value === "opencode") return value;
        throw new Error("Unknown Workbench harness.");
      },
    },
    initialState: options.initialState,
    now: () => options.clock.nowMs,
    setTimeout: options.clock.setTimeout,
    threadState: {
      acceptIntent: async () => ({ accepted: true, revision: 1 }),
      disconnect: async (connectionId) => { options.onDisconnect?.(connectionId); },
      handleRequest: async () => ({ result: { accepted: true, revision: 1 } }),
    },
    writeLine: (line) => { lines.push(line); },
  });
  return { controller, lines };
}

function frame(method: string, id: number, extra: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({ id, method, ...extra }));
}

test("warns every two seconds until the matching response send completes", async () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const client = createClient();
  await controller.handleMessage(client, "connection-1", frame("thread/read", 7, { params: { secret: "never-log-me" } }), false);

  clock.advance(1_999);
  assert.equal(lines.length, 0);
  clock.advance(1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /codex:thread\/read .*pending.* 2\.0s/u);
  clock.advance(2_000);
  assert.equal(lines.length, 2);

  await controller.sendJsonToClient(client, { id: 7, result: { ok: true } });
  assert.equal(lines.length, 3);
  assert.match(lines[2] ?? "", /codex:thread\/read .*ok.*process:.*json:.*send:.*in:.*out:/u);
  assert.equal(lines.join("\n").includes("never-log-me"), false);
  clock.advance(10_000);
  assert.equal(lines.length, 3);
  controller.dispose();
});

test("uses longer first-warning thresholds only for initialization and compaction", async () => {
  const initializeClock = new FakeClock();
  const initialize = createController({ clock: initializeClock });
  await initialize.controller.handleMessage(createClient(), "initialize", frame("initialize", 1), false);
  initializeClock.advance(9_999);
  assert.equal(initialize.lines.length, 0);
  initializeClock.advance(1);
  assert.equal(initialize.lines.length, 1);
  initialize.controller.dispose();

  const compactClock = new FakeClock();
  const compact = createController({ clock: compactClock });
  await compact.controller.handleMessage(createClient(), "compact", frame("thread/compact/start", 2), false);
  compactClock.advance(29_999);
  assert.equal(compact.lines.length, 0);
  compactClock.advance(1);
  assert.equal(compact.lines.length, 1);
  compact.controller.dispose();
});

test("hands pending requests to one replacement warning schedule", async () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const client = createClient();
  const first = createController({ clock, lines });
  await first.controller.handleMessage(client, "connection-1", frame("thread/read", 4), false);
  clock.advance(2_000);
  assert.equal(lines.length, 1);

  const state = first.controller.detachForReload();
  const replacement = createController({ clock, initialState: state, lines });
  clock.advance(2_000);
  assert.equal(lines.length, 2);
  await replacement.controller.sendJsonToClient(client, { id: 4, result: {} });
  clock.advance(4_000);
  assert.equal(lines.length, 3);
  replacement.controller.dispose();
});

test("keeps identical request ids isolated by WebSocket client", async () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const firstClient = createClient();
  const secondClient = createClient();
  await controller.handleMessage(firstClient, "connection-1", frame("thread/read", 1), false);
  await controller.handleMessage(secondClient, "connection-2", frame("model/list", 1, { workbenchHarness: "opencode" }), false);
  await controller.sendJsonToClient(firstClient, { id: 1, result: {} });
  clock.advance(2_000);
  assert.equal(lines.filter((line) => line.includes("codex:thread/read")).length, 1);
  assert.equal(lines.filter((line) => line.includes("opencode:model/list") && line.includes("pending")).length, 1);
  controller.dispose();
});

test("disconnect and send failure terminate their request lifecycles", async () => {
  const clock = new FakeClock();
  const disconnects: string[] = [];
  const { controller, lines } = createController({ clock, onDisconnect: (connectionId) => { disconnects.push(connectionId); } });
  const disconnectedClient = createClient();
  await controller.handleMessage(disconnectedClient, "connection-1", frame("thread/read", 1), false);
  await controller.disconnect(disconnectedClient, "connection-1");
  assert.deepEqual(disconnects, ["connection-1"]);
  assert.match(lines[0] ?? "", /closed/u);

  const failedClient = createClient((_data, callback) => callback?.(new Error("socket write failed")));
  await controller.handleMessage(failedClient, "connection-2", frame("thread/read", 2), false);
  await assert.rejects(controller.sendJsonToClient(failedClient, { id: 2, result: {} }), /socket write failed/u);
  assert.match(lines[1] ?? "", /send-error/u);
  clock.advance(10_000);
  assert.equal(lines.length, 2);
  controller.dispose();
});
