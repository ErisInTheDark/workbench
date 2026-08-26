/*
 * Exports:
 * - No production exports; Node tests protect aggregate stream health, transition-only logs, receipts, reload handoff, and disconnect cleanup. Keywords: websocket, stream, backpressure, acknowledgement, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BridgeClient } from "./bridge-types";
import WorkbenchWebSocketStreamController, { type WorkbenchWebSocketStreamControllerOptions } from "./WorkbenchWebSocketStreamController";

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

type TestClient = BridgeClient & { bufferedAmount: number };

function createClient(): TestClient {
  return {
    OPEN: 1,
    bufferedAmount: 0,
    close() {},
    on() {},
    once() {},
    readyState: 1,
    send() {},
  };
}

function createController(options: {
  clock: FakeClock;
  initialState?: WorkbenchWebSocketStreamControllerOptions["initialState"];
  lines?: string[];
}) {
  const lines = options.lines ?? [];
  const controller = new WorkbenchWebSocketStreamController({
    clearTimeout: options.clock.clearTimeout,
    initialState: options.initialState,
    now: () => options.clock.nowMs,
    setTimeout: options.clock.setTimeout,
    writeLine: (line) => { lines.push(line); },
  });
  return { controller, lines };
}

function prepare(controller: WorkbenchWebSocketStreamController, client: BridgeClient, harness: "codex" | "copilot" | "opencode", method = "item/agentMessage/delta") {
  const event = controller.prepareDelivery(client, {
    method,
    params: { delta: "never-log-me", itemId: "private-item", threadId: "private-thread", turnId: "private-turn" },
    workbenchHarness: harness,
  });
  assert.ok(event);
  return event;
}

test("logs only aggregate behind and recovered transitions", () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const first = createClient();
  const second = createClient();
  const firstEvent = prepare(controller, first, "codex");
  const secondEvent = prepare(controller, second, "opencode");
  controller.commitDelivery(firstEvent, 100);
  controller.commitDelivery(secondEvent, 200);
  controller.acknowledge(second, secondEvent.sequence);

  assert.deepEqual(controller.readEventStreamHealth(), {
    behind: false,
    behindConsumers: 0,
    connectedConsumers: 2,
    oldestUnacknowledgedMs: 0,
    socketBufferedBytes: 0,
    unacknowledgedBytes: 100,
    unacknowledgedEvents: 1,
  });
  clock.advance(1_999);
  assert.deepEqual(lines, []);

  first.bufferedAmount = 64;
  clock.advance(1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /stream .*behind.*consumers: 1\/2 behind.*unacked: 1\/100B.*socket: 64B.*oldest: 2\.0s.*received: 2\/300B.*top: opencode:item\/agentMessage\/delta 1\/200B/u);
  assert.doesNotMatch(lines[0] ?? "", /private|connection|never-log-me/u);

  clock.advance(2_000);
  assert.equal(lines.length, 2);
  first.bufferedAmount = 0;
  controller.acknowledge(first, firstEvent.sequence);
  assert.equal(lines.length, 3);
  assert.match(lines[2] ?? "", /stream .*recovered.*consumers: 2.*peak unacked: 1\/100B.*peak socket: 64B/u);
  assert.equal(controller.readEventStreamHealth().behind, false);

  clock.advance(10_000);
  assert.equal(lines.length, 3);
  controller.dispose();
});

test("keeps receipts isolated and rejects only forward acknowledgements", () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const first = createClient();
  const second = createClient();
  const firstEvent = prepare(controller, first, "codex");
  const secondEvent = prepare(controller, second, "copilot");
  controller.commitDelivery(firstEvent, 30);
  controller.commitDelivery(secondEvent, 40);

  assert.equal(controller.acknowledge(first, firstEvent.sequence), true);
  assert.equal(controller.acknowledge(first, firstEvent.sequence), true);
  assert.equal(controller.readEventStreamHealth().unacknowledgedBytes, 40);
  assert.equal(controller.acknowledge(second, secondEvent.sequence + 1), false);
  assert.deepEqual(lines, [" WS stream invalid acknowledgement"]);
  assert.equal(controller.readEventStreamHealth().unacknowledgedEvents, 1);
  controller.dispose();
});

test("reuses a sequence when delivery stops before reaching the socket", () => {
  const clock = new FakeClock();
  const { controller } = createController({ clock });
  const client = createClient();
  const abandoned = prepare(controller, client, "codex");
  controller.abandonDelivery(abandoned);
  const replacement = prepare(controller, client, "codex");
  assert.equal(replacement.sequence, abandoned.sequence);
  controller.dispose();
});

test("hands one aggregate warning lifecycle to a replacement", () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const client = createClient();
  const first = createController({ clock, lines });
  const event = prepare(first.controller, client, "codex");
  first.controller.commitDelivery(event, 90);
  clock.advance(2_000);
  assert.equal(lines.length, 1);

  const state = first.controller.detachForReload();
  const replacement = createController({ clock, initialState: state, lines });
  clock.advance(1_999);
  assert.equal(lines.length, 1);
  clock.advance(1);
  assert.equal(lines.length, 2);
  replacement.controller.acknowledge(client, event.sequence);
  assert.equal(lines.length, 3);
  assert.match(lines[2] ?? "", /recovered/u);
  replacement.controller.dispose();
});

test("disconnect removes private connection evidence from aggregate health", () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const client = createClient();
  controller.commitDelivery(prepare(controller, client, "codex"), 120);
  clock.advance(2_000);
  assert.equal(controller.readEventStreamHealth().behind, true);

  controller.disconnect(client);
  assert.deepEqual(controller.readEventStreamHealth(), {
    behind: false,
    behindConsumers: 0,
    connectedConsumers: 0,
    oldestUnacknowledgedMs: 0,
    socketBufferedBytes: 0,
    unacknowledgedBytes: 0,
    unacknowledgedEvents: 0,
  });
  assert.match(lines.at(-1) ?? "", /recovered.*consumers: 0/u);
  controller.dispose();
});
