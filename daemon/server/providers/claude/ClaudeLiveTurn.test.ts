/* No production exports. Tests protect Claude live-turn admission order, settlement, lifecycle publication, and steer delivery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import ClaudeLiveTurn, { ClaudePromptQueue } from "./ClaudeLiveTurn";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
const steerId = "00000000-0000-4000-8000-000000000003";
const projectId = ProjectIdSchema.parse("00000000-0000-4000-8000-000000000004");

const result = (overrides: object = {}) => ({
  type: "result", subtype: "success", is_error: false, queued_turn_count: 0,
  usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {}, ...overrides,
});
const ack = (uuid: string) => ({ type: "user", isReplay: true, uuid, parent_tool_use_id: null, message: { role: "user", content: "" } });

class RecordingQueue extends ClaudePromptQueue {
  readonly pushed: SDKUserMessage[] = [];
  override push(value: SDKUserMessage) {
    this.pushed.push(value);
    super.push(value);
  }
}

function fixture(onAccepted?: (turn: ClaudeLiveTurn, log: string[]) => void) {
  const pending: (object | Error)[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const push = (value: object | Error) => { pending.push(value); wake?.(); };
  const query = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const next = pending.shift();
        if (next instanceof Error) throw next;
        if (next) yield next;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    },
    interrupt: async () => { push(result({ subtype: "error_during_execution", is_error: true })); },
    close: () => { closed = true; wake?.(); },
  };
  const log: string[] = [];
  const steers: WorkbenchSteerHistoryEntry[] = [];
  const queue = new RecordingQueue();
  const turn: ClaudeLiveTurn = new ClaudeLiveTurn({
    query: query as never, queue, scope: "scope", cwd: "C:/repo",
    projectId, threadId, turnId, workingStatusInPrompt: false, usage: null,
    transcript: {
      recordStreamEvent: async () => undefined,
      recordAssistant: async () => undefined,
      recordNativeToolResults: async () => undefined,
      recordCompaction: async () => undefined,
      recordContextUsage: async () => undefined,
      recordSteer: async (entry: WorkbenchSteerHistoryEntry) => { steers.push(entry); },
      settleTurn: async (_turnId: string, status: string) => { log.push(`settle:${status}`); },
    } as never,
    observe: async facts => {
      if (facts.activity) log.push(`activity:${facts.activity.kind}`);
      if (!facts.lifecycle) return;
      assert.equal(facts.projectId, projectId, "lifecycle facts must apply before thread state loads the project");
      log.push(`observe:${facts.lifecycle.event.kind}${
        facts.lifecycle.event.kind === "turnCompleted" ? `:${facts.lifecycle.event.status}` : ""}`);
      if (facts.lifecycle.event.kind === "acceptedIntent") {
        log.push(`prompts:${queue.pushed.length}`);
        onAccepted?.(turn, log);
      }
    },
    broadcast: notification => {
      log.push(notification.method === "thread/status/changed"
        ? `status:${notification.params.status.type}` : notification.method);
    },
    readTurn: async () => ({ id: turnId, status: "inProgress" }) as never,
    processExit: async () => undefined,
    stderr: () => "",
    release: async () => { log.push("release"); },
  });
  return { turn, push, log, steers, queue };
}

const steer = (): WorkbenchSteerHistoryEntry => ({
  threadId, turnId, itemId: steerId, entryKey: steerId, input: [], status: "pending",
  attemptedAt: 1, resolvedAt: null, requestId: null, canonicalItemId: null, dispatchSequence: null, error: null,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test("a completed turn is accepted before its prompt and releases its process before one idle settlement", async () => {
  const { turn, push, log } = fixture();
  const { task } = await turn.start("hi");
  push(result());
  await task;
  assert.deepEqual(log, [
    "activity:turnStarted", "observe:acceptedIntent", "prompts:0", "status:active", "turn/started",
    "release", "settle:completed", "observe:turnCompleted:completed", "turn/completed", "status:idle",
  ]);
});

test("context injected by acceptance prefixes the prompt and early steers follow it", async () => {
  const { turn, push, queue } = fixture(accepted => {
    accepted.inject("<wb:thread-status value=\"working\" />");
    accepted.steer(steer(), "and then this");
  });
  const { task } = await turn.start("do the thing");
  assert.deepEqual(queue.pushed.map(message => [message.message.content, message.isSynthetic ?? false, message.uuid === steerId]), [
    ["<wb:thread-status value=\"working\" />\n\ndo the thing", false, false],
    ["and then this", false, true],
  ]);
  push(ack(steerId));
  push(result());
  await task;
});

test("a failed query settles failed and still publishes idle", async context => {
  context.mock.method(console, "error", () => undefined);
  const { turn, push, log } = fixture();
  const { task } = await turn.start("hi");
  push(new Error("native crash"));
  await task;
  assert.deepEqual(log.slice(5), ["release", "settle:failed", "observe:turnCompleted:failed", "turn/completed", "status:idle"]);
});

test("interruption settles exactly once as interrupted and retires undelivered steers", async () => {
  const { turn, log, steers } = fixture();
  await turn.start("hi");
  turn.steer(steer(), "wait");
  await turn.interrupt();
  await turn.interrupt();
  assert.deepEqual(log.filter(entry => entry.startsWith("settle")), ["settle:interrupted"]);
  assert.deepEqual(log.filter(entry => entry.startsWith("observe:turnCompleted")), ["observe:turnCompleted:interrupted"]);
  assert.deepEqual(steers.map(entry => entry.status), ["interrupted"]);
});

test("a steer stays pending until Claude acknowledges folding it in", async () => {
  const { turn, push, steers } = fixture();
  const { task } = await turn.start("hi");
  turn.steer(steer(), "change course");
  await tick();
  assert.deepEqual(steers, []);
  push(ack(steerId));
  await tick();
  assert.deepEqual(steers.map(entry => [entry.status, entry.canonicalItemId]), [["sent", steerId]]);
  push(result());
  await task;
  assert.equal(steers.length, 1);
});

test("a steer still queued when Claude's reply ends keeps the Workbench turn open for its follow-up", async () => {
  const { turn, push, log, steers } = fixture();
  const { task } = await turn.start("hi");
  turn.steer(steer(), "one more thing");
  push(result({ queued_turn_count: 1 }));
  await tick();
  assert.ok(!log.includes("release"), "the query must stay open while a steer is queued");
  push(ack(steerId));
  push(result());
  await task;
  assert.deepEqual(steers.map(entry => entry.status), ["sent"]);
  assert.deepEqual(log.filter(entry => entry.startsWith("settle")), ["settle:completed"]);
});

test("late queued context that is not a steer does not hold the turn open for another model turn", async () => {
  const { turn, push, log } = fixture();
  const { task } = await turn.start("hi");
  turn.inject("<wb:thread-status value=\"working\" />");
  push(result({ queued_turn_count: 1 }));
  await task;
  assert.deepEqual(log.filter(entry => entry.startsWith("settle")), ["settle:completed"]);
});

test("a steer consumed without an ack is still delivered from the result's consumed list", async () => {
  const { turn, push, steers } = fixture();
  const { task } = await turn.start("hi");
  turn.steer(steer(), "folded silently");
  push(result({ user_message_uuids: ["first", steerId] }));
  await task;
  assert.deepEqual(steers.map(entry => entry.status), ["sent"]);
});
