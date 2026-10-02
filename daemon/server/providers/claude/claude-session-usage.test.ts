/*
 * No production exports. Protect Claude session-log call dedupe and per-turn cumulative usage assignment.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { ClaudeSessionCallReader, claudeTurnUsage } from "./claude-session-usage";

const T0 = Date.parse("2026-10-02T00:00:00.000Z");

function line(input: {
  id: string; at: number; model?: string; sidechain?: boolean;
  input?: number; output?: number; read?: number; write?: number;
}) {
  return JSON.stringify({
    type: "assistant", isSidechain: input.sidechain ?? false, timestamp: new Date(input.at).toISOString(),
    message: {
      id: input.id, model: input.model ?? "claude-opus", content: [],
      usage: {
        input_tokens: input.input ?? 1, output_tokens: input.output ?? 10,
        cache_read_input_tokens: input.read ?? 100, cache_creation_input_tokens: input.write ?? 5,
      },
    },
  });
}

function read(lines: string[]) {
  const reader = new ClaudeSessionCallReader();
  for (const value of lines) reader.push(value);
  return reader;
}

const turn = (id: string, startedAt: number | null) => ({ id: WorkbenchTurnIdSchema.parse(id), startedAt });

test("content-block lines of one message count once with the message's final usage", () => {
  const reader = read([
    line({ id: "m1", at: T0 + 1, output: 2 }),
    line({ id: "m1", at: T0 + 2, output: 40 }),
    JSON.stringify({ type: "user", message: { content: "tool result" } }),
  ]);
  const calls = reader.read();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.usage.outputTokens, 40);
  assert.equal(calls[0]!.occurredAt, T0 + 1);
  assert.equal(reader.malformed, 0);
});

test("subagent sidechain calls and synthetic messages are not billed to the conversation", () => {
  const calls = read([
    line({ id: "main", at: T0 + 1 }),
    line({ id: "side", at: T0 + 2, sidechain: true }),
    line({ id: "local", at: T0 + 3, model: "<synthetic>" }),
  ]).read();
  assert.deepEqual(calls.map(call => call.model), ["claude-opus"]);
});

test("only a half-written final line is excused from the malformed count", () => {
  const truncated = line({ id: "m2", at: T0 + 2 }).slice(0, 60);
  assert.equal(read([line({ id: "m1", at: T0 + 1 }), truncated]).malformed, 0);
  assert.equal(read([truncated, line({ id: "m3", at: T0 + 3 })]).malformed, 1);
});

test("calls split across turns by start time and every started turn carries the cumulative total", () => {
  const calls = read([
    line({ id: "early", at: T0 - 5, input: 1, read: 0, write: 0, output: 1 }),
    line({ id: "a", at: T0 + 10, input: 10, read: 0, write: 0, output: 1 }),
    line({ id: "b", at: T0 + 30, input: 100, read: 0, write: 0, output: 1 }),
  ]).read();
  const usage = claudeTurnUsage(calls, [
    turn("third", T0 + 40), turn("first", T0), turn("second", T0 + 20), turn("unstarted", null),
  ]);
  assert.deepEqual(usage.map(row => [row.turnId, row.cumulative.inputTokens]), [
    ["first", 11], ["second", 111], ["third", 111],
  ]);
  assert.equal(usage[2]!.model, null);
});

test("a turn using several models reports its heaviest model as main and flags the mix", () => {
  const calls = read([
    line({ id: "helper", at: T0 + 1, model: "claude-haiku", input: 5, read: 0, write: 0 }),
    line({ id: "main", at: T0 + 2, model: "claude-opus", input: 5, read: 500, write: 0 }),
  ]).read();
  const [row] = claudeTurnUsage(calls, [turn("only", T0)]);
  assert.equal(row!.model, "claude-opus");
  assert.equal(row!.mixedModels, true);
});
