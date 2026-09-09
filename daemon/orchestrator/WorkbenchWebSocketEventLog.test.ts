/*
 * Keywords: websocket, event logs, independent windows, traffic, disposal.
 * No production exports. Tests protect aggregation, exclusions and scheduler ownership.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKBENCH_EVENT_STREAM_ACK_METHOD } from "workbench-shared/workbench/websocket-stream";
import WorkbenchWebSocketEventLog from "./WorkbenchWebSocketEventLog";

function fixture() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const lines: string[] = [];
  const logger = new WorkbenchWebSocketEventLog({
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = ++nextId;
      timers.set(id, { due: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => { timers.delete(timer as unknown as number); },
    writeLine: (line) => { lines.push(line.replace(/\u001b\[[0-9;]*m/gu, "")); },
  });
  return {
    logger, lines, timers,
    advance(duration: number) {
      const target = now + duration;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    },
  };
}

test("event types aggregate independently without aligning their windows", () => {
  const { logger, lines, timers, advance } = fixture();
  logger.record("out", "codex", "item/agentMessage/delta", 100);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /count: 1, out: 100B/);
  advance(700);
  logger.record("out", "workbench", "workbench/thread-state/updated", 200);
  logger.record("out", "codex", "item/agentMessage/delta", 300);
  logger.record("out", "workbench", "workbench/thread-state/updated", 400);
  assert.equal(lines.length, 2);
  assert.equal(timers.size, 1);
  advance(1_300);
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /codex:item\/agentMessage\/delta/);
  assert.match(lines[2]!, /count: 1, out: 300B/);
  advance(700);
  assert.equal(lines.length, 4);
  assert.match(lines[3]!, /wb:thread-state\/updated/);
  assert.match(lines[3]!, /count: 1, out: 400B/);
  advance(10_000);
  assert.equal(lines.length, 4);
  assert.equal(timers.size, 0);
  logger.dispose();
});

test("direction and harness separate matching methods and later traffic opens a fresh window", () => {
  const { logger, lines, advance } = fixture();
  logger.record("in", "codex", "initialized", 10);
  logger.record("out", "codex", "initialized", 20);
  logger.record("out", "copilot", "initialized", 30);
  assert.equal(lines.length, 3);
  assert.ok(lines.some(line => line.includes("in codex:initialized") && line.includes("in: 10B")));
  assert.ok(lines.some(line => line.includes("out codex:initialized") && line.includes("out: 20B")));
  assert.ok(lines.some(line => line.includes("out copilot:initialized") && line.includes("out: 30B")));
  advance(2_500);
  logger.record("out", "codex", "initialized", 40);
  assert.equal(lines.length, 4);
  assert.match(lines[3]!, /count: 1, out: 40B/);
  logger.dispose();
});

test("excluded incoming receipts schedule nothing without hiding other traffic", () => {
  const { logger, lines, timers, advance } = fixture();
  logger.record("in", "workbench", WORKBENCH_EVENT_STREAM_ACK_METHOD, 100);
  assert.equal(timers.size, 0);
  logger.record("out", "workbench", WORKBENCH_EVENT_STREAM_ACK_METHOD, 120);
  assert.equal(lines.length, 1);
  advance(2_000);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /out wb:event-stream\/ack/);
  assert.match(lines[0]!, /count: 1, out: 120B/);
  logger.dispose();
});

test("disposal flushes partial windows once and cannot resurrect logging", () => {
  const { logger, lines, timers, advance } = fixture();
  logger.record("out", "codex", "thread/started", 50);
  assert.equal(lines.length, 1);
  advance(300);
  logger.record("out", "codex", "thread/started", 70);
  logger.dispose();
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /count: 1, out: 50B/);
  assert.match(lines[1]!, /count: 1, out: 70B/);
  assert.equal(timers.size, 0);
  logger.dispose();
  logger.record("out", "codex", "thread/started", 50);
  advance(3_000);
  assert.equal(lines.length, 2);
  assert.equal(timers.size, 0);
});

test("continuous traffic never postpones a deadline or bypasses the next cooldown", () => {
  const { logger, lines, advance } = fixture();
  logger.record("out", "codex", "delta", 10);
  assert.equal(lines.length, 1);
  for (let window = 0; window < 3; window += 1) {
    for (let event = 0; event < 4; event += 1) {
      logger.record("out", "codex", "delta", 20);
      assert.equal(lines.length, window + 1);
      advance(500);
    }
    assert.equal(lines.length, window + 2);
    assert.match(lines.at(-1)!, /count: 4, out: 80B/);
  }
  logger.dispose();
  assert.equal(lines.length, 4);
});
