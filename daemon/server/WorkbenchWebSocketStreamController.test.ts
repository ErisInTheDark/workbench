/*
 * Exports:
 * - No production exports; Node tests protect stream health, lag-report rankings and cadence, receipts, reload handoff, and cleanup.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BridgeClient } from "./bridge-types";
import WorkbenchWebSocketStreamController, { type WorkbenchWebSocketStreamControllerOptions } from "./WorkbenchWebSocketStreamController";

class FakeClock {
  cancelledTimerCount = 0;
  nowMs = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  readonly clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    if (this.timers.delete(timer as unknown as number)) this.cancelledTimerCount += 1;
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

  advanceLate(durationMs: number) {
    this.nowMs += durationMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.nowMs)
      .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0]);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
  }

  elapseWithoutTimers(durationMs: number) {
    this.nowMs += durationMs;
  }

  nextTimerDueAt() {
    return Math.min(...[...this.timers.values()].map((timer) => timer.dueAt));
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
  readMemoryUsage?: WorkbenchWebSocketStreamControllerOptions["readMemoryUsage"];
}) {
  const lines = options.lines ?? [];
  const controller = new WorkbenchWebSocketStreamController({
    clearTimeout: options.clock.clearTimeout,
    initialState: options.initialState,
    now: () => options.clock.nowMs,
    readMemoryUsage: options.readMemoryUsage,
    setTimeout: options.clock.setTimeout,
    writeLine: (line) => { lines.push(line); },
  });
  return { controller, lines };
}

function memory(heapUsedMb: number, heapTotalMb: number, rssMb: number) {
  const megabyte = 1_024 * 1_024;
  return {
    heapTotal: heapTotalMb * megabyte,
    heapUsed: heapUsedMb * megabyte,
    rss: rssMb * megabyte,
  };
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

test("rollback preserves delivery receipts and final disposal cannot be resumed", () => {
  const clock = new FakeClock();
  const { controller } = createController({ clock });
  const client = createClient();
  const event = prepare(controller, client, "codex");
  controller.commitDelivery(event, 100);
  controller.detachForReload();
  clock.advance(5_000);
  controller.resumeAfterFailedReload();
  assert.equal(controller.readEventStreamHealth().unacknowledgedEvents, 1);
  assert.equal(controller.acknowledge(client, event.sequence), true);
  assert.equal(controller.readEventStreamHealth().unacknowledgedEvents, 0);
  controller.detachForReload();
  controller.dispose();
  assert.throws(() => controller.resumeAfterFailedReload(), /disposed/u);
});

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
  assert.match(lines[0] ?? "", /stream .*behind.*consumers: 1\/2 behind.*unacked: 1\/100B.*socket: 64B.*oldest: 2\.0s.*received: 2\/300B.*top received: opencode:item\/agentMessage\/delta 1\/200B/u);
  assert.doesNotMatch(lines[0] ?? "", /private|connection|never-log-me/u);

  const laterEvent = prepare(controller, first, "codex", "turn/diff/updated");
  controller.commitDelivery(laterEvent, 300);
  clock.advance(2_000);
  assert.equal(lines.length, 2);
  first.bufferedAmount = 0;
  controller.acknowledge(first, laterEvent.sequence);
  assert.equal(lines.length, 3);
  const recovery = lines[2] ?? "";
  assert.match(recovery, /stream .*recovered.*cause: acknowledged/u);
  assert.match(recovery, /consumers: 1 affected \/ 2 connected/u);
  assert.match(recovery, /stream pressure: peak 2 events \/ 400B unacknowledged \| peak socket 64B/u);
  assert.match(recovery, /outcomes: 2 events \/ 400B acknowledged.*0 events \/ 0B disconnected.*0 events \/ 0B still pending/u);
  assert.match(recovery, /unacked by count:[\s\S]*1\. codex:item\/agentMessage\/delta \| 1 event \(100B, longest unacked 4\.0s\)/u);
  assert.match(recovery, /unacked by size:[\s\S]*1\. codex:turn\/diff\/updated \| 300B \(1 event, longest unacked 2\.0s\)/u);
  assert.match(recovery, /longest unacked:[\s\S]*1\. codex:item\/agentMessage\/delta \| 4\.0s \(1 event \/ 100B\)/u);
  assert.doesNotMatch(recovery, /opencode|private|connection|never-log-me/u);
  assert.equal(controller.readEventStreamHealth().behind, false);

  clock.advance(10_000);
  assert.equal(lines.length, 3);
  controller.dispose();
});

test("ranks incident labels independently while retaining cross-metric context", () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const client = createClient();
  const longest = prepare(controller, client, "copilot", "item/plan/delta");
  controller.commitDelivery(longest, 100);
  clock.advance(500);
  controller.commitDelivery(prepare(controller, client, "codex"), 40);
  controller.commitDelivery(prepare(controller, client, "codex"), 40);
  controller.commitDelivery(prepare(controller, client, "codex"), 40);
  clock.advance(500);
  const largest = prepare(controller, client, "opencode", "turn/diff/updated");
  controller.commitDelivery(largest, 500);
  clock.advance(1_000);
  controller.acknowledge(client, largest.sequence);

  const report = lines.at(-1) ?? "";
  assert.match(report, /unacked by count:[\s\S]*1\. codex:item\/agentMessage\/delta \| 3 events \(120B, longest unacked 1\.5s\)/u);
  assert.match(report, /unacked by size:[\s\S]*1\. opencode:turn\/diff\/updated \| 500B \(1 event, longest unacked 1\.0s\)/u);
  assert.match(report, /longest unacked:[\s\S]*1\. copilot:item\/plan\/delta \| 2\.0s \(1 event \/ 100B\)/u);
  controller.dispose();
});

test("prints one full incident report instead of the compact warning every thirty seconds", () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const client = createClient();
  controller.commitDelivery(prepare(controller, client, "codex"), 100);

  clock.advance(28_000);
  assert.equal(lines.length, 14);
  assert.ok(lines.every((line) => !line.includes("\n")));
  clock.advance(2_000);
  assert.equal(lines.length, 15);
  assert.match(lines[14] ?? "", /stream .*behind.*after 30\.0s[\s\S]*unacked by count:[\s\S]*unacked by size:[\s\S]*longest unacked:/u);
  clock.advance(2_000);
  assert.equal(lines.length, 16);
  assert.doesNotMatch(lines[15] ?? "", /\n/u);
  clock.advance(28_000);
  assert.equal(lines.length, 30);
  assert.match(lines[29] ?? "", /stream .*behind.*after 60\.0s[\s\S]*unacked by count:/u);
  controller.dispose();
});

test("prints one current full report without backfilling delayed warning intervals", () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const client = createClient();
  controller.commitDelivery(prepare(controller, client, "codex"), 100);

  clock.advanceLate(65_000);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /stream .*behind.*after 65\.0s[\s\S]*unacked by count:/u);
  clock.advance(2_000);
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines[1] ?? "", /\n/u);
  controller.dispose();
});

test("hot deliveries do not rearm an overdue stream warning", () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const client = createClient();
  controller.commitDelivery(prepare(controller, client, "codex"), 100);
  assert.equal(clock.nextTimerDueAt(), 2_000);

  clock.elapseWithoutTimers(2_500);
  let latest = prepare(controller, client, "codex");
  controller.commitDelivery(latest, 20);
  for (let index = 0; index < 20; index += 1) {
    latest = prepare(controller, client, "codex");
    controller.commitDelivery(latest, 20);
  }

  assert.equal(clock.cancelledTimerCount, 0);
  assert.equal(clock.nextTimerDueAt(), 2_000);
  clock.advanceLate(0);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /stream .*behind.*for 2\.5s/u);
  controller.acknowledge(client, latest.sequence);
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? "", /stream .*recovered.*after 2\.5s/u);
  controller.dispose();
});

test("reports cumulative runtime pressure on one-line warnings and across reload recovery", () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const readings = [
    memory(80, 100, 150),
    memory(120, 160, 210),
    memory(110, 150, 190),
    memory(100, 140, 180),
  ];
  const readMemoryUsage = () => readings.shift() ?? memory(100, 140, 180);
  const client = createClient();
  const first = createController({ clock, lines, readMemoryUsage });
  const event = prepare(first.controller, client, "codex");
  first.controller.commitDelivery(event, 100);

  clock.advanceLate(7_000);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /\n/u);
  assert.match(
    lines[0] ?? "",
    /for 7\.0s \u001b\[2m\(.*warning callback: 5\.0s late, rss: 210\.0MB, heap: 120\.0MB\/160\.0MB\)\u001b\[0m$/u,
  );

  const state = first.controller.detachForReload();
  assert.equal(state.runtimePressure?.peakWarningLatenessMs, 5_000);
  assert.equal(state.runtimePressure?.baselineMemory.heapUsedBytes, 80 * 1_024 * 1_024);
  const replacement = createController({ clock, initialState: state, lines, readMemoryUsage });

  clock.advance(2_000);
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? "", /warning callback: 0ms late, rss: 190\.0MB, heap: 110\.0MB\/150\.0MB/u);
  replacement.controller.acknowledge(client, event.sequence);
  assert.equal(lines.length, 3);
  const recovery = lines[2] ?? "";
  assert.match(recovery, /warning callback: 0ms late \| peak 5\.0s late/u);
  assert.match(recovery, /daemon rss: 180\.0MB current \| 210\.0MB peak \| \+30\.0MB from first unacked/u);
  assert.match(recovery, /daemon heap: 100\.0MB \/ 140\.0MB current \| 120\.0MB peak \| \+20\.0MB from first unacked/u);
  assert.ok(recovery.split("\n").slice(1).every((line) => (
    line.startsWith("\u001b[2m") && line.endsWith("\u001b[0m")
  )));
  replacement.controller.dispose();
});

test("bounds healthy-stream memory sampling without adding a recurring timer", () => {
  const clock = new FakeClock();
  let memoryReads = 0;
  const { controller, lines } = createController({
    clock,
    readMemoryUsage: () => {
      memoryReads += 1;
      return memory(80, 100, 150);
    },
  });
  const client = createClient();

  for (let index = 0; index < 100; index += 1) {
    const event = prepare(controller, client, "codex");
    controller.commitDelivery(event, 10);
    controller.acknowledge(client, event.sequence);
  }
  assert.equal(memoryReads, 1);
  assert.deepEqual(lines, []);

  clock.advance(2_000);
  const laterEvent = prepare(controller, client, "codex");
  controller.commitDelivery(laterEvent, 10);
  controller.acknowledge(client, laterEvent.sequence);
  assert.equal(memoryReads, 2);
  assert.deepEqual(lines, []);
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
  clock.advance(27_999);
  assert.equal(lines.length, 14);
  clock.advance(1);
  assert.equal(lines.length, 15);
  assert.match(lines[14] ?? "", /stream .*behind.*after 30\.0s[\s\S]*unacked by count:/u);
  replacement.controller.acknowledge(client, event.sequence);
  assert.equal(lines.length, 16);
  assert.match(lines[15] ?? "", /recovered[\s\S]*consumers: 1 affected[\s\S]*unacked by count:[\s\S]*1 event \(90B, longest unacked 30\.0s\)/u);
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
  const conclusion = lines.at(-1) ?? "";
  assert.match(conclusion, /stream .*ended.*cause: disconnected/u);
  assert.match(conclusion, /consumers: 1 affected \/ 0 connected/u);
  assert.match(conclusion, /outcomes: 0 events \/ 0B acknowledged.*1 event \/ 120B disconnected/u);
  assert.match(conclusion, /codex:item\/agentMessage\/delta \| 1 event \(120B, longest unacked 2\.0s\)/u);
  assert.doesNotMatch(conclusion, /private|connection|never-log-me/u);
  controller.dispose();
});

test("reports delivery failure as a non-recovery incident outcome", () => {
  const clock = new FakeClock();
  const { controller, lines } = createController({ clock });
  const client = createClient();
  const event = prepare(controller, client, "copilot", "item/plan/delta");
  controller.commitDelivery(event, 75);
  clock.advance(2_000);

  controller.failDelivery(event);

  const conclusion = lines.at(-1) ?? "";
  assert.match(conclusion, /stream .*ended.*cause: delivery failed/u);
  assert.match(conclusion, /outcomes: 0 events \/ 0B acknowledged \| 1 event \/ 75B delivery failed/u);
  assert.match(conclusion, /copilot:item\/plan\/delta \| 1 event \(75B, longest unacked 2\.0s\)/u);
  controller.dispose();
});
