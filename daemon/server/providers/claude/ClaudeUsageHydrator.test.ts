/*
 * No production exports. Protect Claude usage hydration from session logs, missing logs, and trigger coalescing.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import ClaudeUsageHydrator, { type ClaudeUsageHydratorOptions } from "./ClaudeUsageHydrator";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const sessionId = "00000000-0000-4000-8000-0000000000aa";
const T0 = Date.parse("2026-10-02T00:00:00.000Z");
const turns = [
  { id: WorkbenchTurnIdSchema.parse("turn-completed"), startedAt: T0 },
  // A reload killed this turn before Claude's result; only the session log knows its calls.
  { id: WorkbenchTurnIdSchema.parse("turn-killed"), startedAt: T0 + 1_000 },
];

const call = (id: string, at: number, input: number) => JSON.stringify({
  type: "assistant", isSidechain: false, timestamp: new Date(at).toISOString(),
  message: { id, model: "claude-opus", usage: { input_tokens: input, output_tokens: 1 } },
});

async function fixture(t: test.TestContext, lines: string[] | null) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-usage-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataRoot, "projects", "C--other"), { recursive: true });
  if (lines) {
    await fs.mkdir(path.join(dataRoot, "projects", "C--repo"), { recursive: true });
    await fs.writeFile(path.join(dataRoot, "projects", "C--repo", `${sessionId}.jsonl`), lines.join("\n"));
  }
  const recorded: Array<[string, number]> = [];
  let reads = 0;
  const options: ClaudeUsageHydratorOptions = {
    dataRoot,
    signal: new AbortController().signal,
    readThread: async () => {
      reads += 1;
      return { threadId, sessionId, turns };
    },
    record: async (_thread, usage) => { recorded.push([usage.turnId, usage.cumulative.inputTokens]); },
  };
  return { options, recorded, reads: () => reads };
}

test("every turn gets usage from the session log, including a turn that never reached its result", async (t) => {
  const { options, recorded } = await fixture(t, [call("a", T0 + 10, 5), call("b", T0 + 1_500, 7)]);
  assert.equal(await new ClaudeUsageHydrator(options).hydrate(threadId), "completed");
  assert.deepEqual(recorded, [["turn-completed", 5], ["turn-killed", 12]]);
});

test("a thread without a session log is unavailable and records nothing", async (t) => {
  const { options, recorded } = await fixture(t, null);
  assert.equal(await new ClaudeUsageHydrator(options).hydrate(threadId), "unavailable");
  assert.deepEqual(recorded, []);
});

test("a burst of triggers during a read costs one follow-up read that sees the newest log", async (t) => {
  const { options, recorded, reads } = await fixture(t, [call("a", T0 + 10, 5)]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const readThread = options.readThread;
  const hydrator = new ClaudeUsageHydrator({
    ...options,
    readThread: async (id) => {
      if (reads() === 0) await gate;
      return readThread(id);
    },
  });
  const first = hydrator.hydrate(threadId);
  const burst = [hydrator.hydrate(threadId), hydrator.hydrate(threadId)];
  const file = path.join(options.dataRoot, "projects", "C--repo", `${sessionId}.jsonl`);
  await fs.appendFile(file, `\n${call("b", T0 + 20, 7)}`);
  release();
  assert.deepEqual(await Promise.all([first, ...burst]), ["completed", "completed", "completed"]);
  assert.equal(reads(), 2);
  assert.deepEqual(recorded.at(-1), ["turn-killed", 12]);
  assert.equal(hydrator.hasPendingWork(), false);
});
