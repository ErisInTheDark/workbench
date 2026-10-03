/* No production exports. Tests protect Claude live-turn admission order, settlement, lifecycle publication, steer and working-notice delivery, and reload restoration. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import ClaudeLiveTurn, { type ClaudeLiveTurnCollaborators } from "./ClaudeLiveTurn";
import { ClaudeProcessSession, ClaudePromptQueue } from "./ClaudeSessionHost";

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

const assistant = (inputTokens: number) => ({
  type: "assistant", parent_tool_use_id: null,
  message: { role: "assistant", content: [], usage: { input_tokens: inputTokens, output_tokens: 1 } },
});
const contextWindowUsage = (contextWindow: number) => ({
  "claude-opus-5-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow },
});

function fixture(
  onAccepted?: (turn: ClaudeLiveTurn, log: string[]) => void,
  usage: ConstructorParameters<typeof ClaudeLiveTurn>[0]["usage"] = null,
  contextWindow: number | null = null,
  workingStatusInPrompt = false,
) {
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
  const usageSignals: string[] = [];
  const liveUsage: Array<{ input: number | null; window: number | null }> = [];
  const session = new ClaudeProcessSession("scope", query as never, queue, {
    exit: async () => undefined, stderr: () => "", release: async () => undefined,
  });
  let turn!: ClaudeLiveTurn;
  const collaborators: ClaudeLiveTurnCollaborators = {
    session,
    transcript: {
      recordStreamEvent: async () => undefined,
      recordAssistant: async () => undefined,
      recordNativeToolResults: async () => undefined,
      recordCompactionMessage: async () => undefined,
      recordContextUsage: async () => undefined,
      recordSteer: async (entry: WorkbenchSteerHistoryEntry) => { steers.push(entry); },
      settleTurn: async (_turnId: string, status: string) => { log.push(`settle:${status}`); },
    } as never,
    // The latest log entry shows whether the signal followed settlement.
    usageChanged: () => { usageSignals.push(log.at(-1) ?? "start"); },
    observe: async facts => {
      if (facts.turnStarted) log.push("turnStarted");
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
      if (notification.method === "thread/tokenUsage/updated") {
        const { tokenUsage } = notification.params;
        liveUsage.push({ input: tokenUsage.last.inputTokens, window: tokenUsage.modelContextWindow });
        return;
      }
      log.push(notification.method === "thread/status/changed"
        ? `status:${notification.params.status.type}` : notification.method);
    },
    readTurn: async () => ({ id: turnId, status: "inProgress" }) as never,
    release: async () => { log.push("release"); },
    settling: status => { log.push(`reported:${status}`); },
  };
  turn = new ClaudeLiveTurn({
    scope: "scope", cwd: "C:/repo", projectId, threadId, turnId, workingStatusInPrompt, usage, contextWindow,
    ...collaborators,
  });
  return { turn, push, log, steers, queue, usageSignals, liveUsage, collaborators };
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
    "turnStarted", "observe:acceptedIntent", "prompts:0", "status:active", "turn/started",
    // Settlement is reported before the observation that lets Workbench core continue the turn.
    "release", "settle:completed", "reported:completed", "observe:turnCompleted:completed", "turn/completed", "status:idle",
  ]);
});

test("billing usage is re-derived after each result and again once the turn settles", async () => {
  const { turn, push, usageSignals } = fixture();
  const { task } = await turn.start("hi");
  push(result());
  await task;
  assert.deepEqual(usageSignals, ["turn/started", "settle:completed"]);
});

test("a turn that dies before any result still re-derives billing usage after settling", async context => {
  context.mock.method(console, "error", () => undefined);
  const { turn, push, usageSignals } = fixture();
  const { task } = await turn.start("hi");
  push(new Error("native crash"));
  await task;
  assert.deepEqual(usageSignals, ["settle:failed"]);
});

test("context usage reaches clients live under the selected window, which Claude's reported window cannot replace", async () => {
  const { turn, push, liveUsage } = fixture(undefined, null, 300_000);
  const { task } = await turn.start("hi");
  push(assistant(40_000));
  await tick();
  assert.deepEqual(liveUsage, [{ input: 40_000, window: 300_000 }], "the first model round must already know the window");
  push(result({ modelUsage: contextWindowUsage(1_000_000) }));
  await task;
  assert.deepEqual(liveUsage.map(entry => entry.window), [300_000, 300_000]);
});

test("without a selected window, live usage learns the window Claude reports", async () => {
  const { turn, push, liveUsage } = fixture();
  const { task } = await turn.start("hi");
  push(assistant(40_000));
  push(result({ modelUsage: contextWindowUsage(1_000_000) }));
  await task;
  assert.deepEqual(liveUsage.map(entry => entry.window), [null, 1_000_000]);
});

test("injected screenshots reach Claude as images after the prompt and are refused once the turn closes", async () => {
  const image = [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" } }];
  const { turn, push, queue } = fixture(accepted => accepted.injectContent(image));
  const { task } = await turn.start("look at this");
  turn.injectContent(image);
  assert.deepEqual(queue.pushed.map(message => [message.message.content, message.isSynthetic ?? false]), [
    ["look at this", false], [image, true], [image, true],
  ]);
  push(result());
  await task;
  assert.throws(() => turn.injectContent(image), /closing/u);
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

test("image prompts and steers reach Claude as content blocks behind acceptance context", async () => {
  const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" } };
  const { turn, push, queue } = fixture(accepted => {
    accepted.inject("<wb:thread-status value=\"working\" />");
    accepted.steer(steer(), [image]);
  });
  const { task } = await turn.start([{ type: "text", text: "look" }, image]);
  assert.deepEqual(queue.pushed.map(message => message.message.content), [
    [{ type: "text", text: "<wb:thread-status value=\"working\" />\n\nlook" }, image],
    [image],
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
  assert.deepEqual(log.slice(5), ["release", "settle:failed", "reported:failed", "observe:turnCompleted:failed", "turn/completed", "status:idle"]);
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

test("a launch prompt carrying the working notice drops only acceptance's duplicate, and later transitions still reach Claude", async () => {
  const notice = "<wb:thread-status value=\"working\" />";
  const { turn, push, queue } = fixture(accepted => accepted.injectWorkingStatus(notice), null, null, true);
  const { task } = await turn.start("do the thing");
  turn.injectWorkingStatus(notice);
  assert.deepEqual(queue.pushed.map(message => [message.message.content, message.isSynthetic ?? false]), [
    ["do the thing", false], [notice, true],
  ]);
  push(result());
  await task;
});

test("late queued context that is not a steer does not hold the turn open for another model turn", async () => {
  const { turn, push, log } = fixture();
  const { task } = await turn.start("hi");
  turn.inject("<wb:thread-status value=\"working\" />");
  push(result({ queued_turn_count: 1 }));
  await task;
  assert.deepEqual(log.filter(entry => entry.startsWith("settle")), ["settle:completed"]);
});

test("a bridge reload pauses the turn without settling it and its restored successor finishes from buffered output", async () => {
  const { turn, push, log, steers, liveUsage, collaborators } = fixture(undefined, null, 300_000);
  await turn.start("hi");
  turn.steer(steer(), "change course");
  push(assistant(40_000));
  await tick();
  await turn.pause();
  push(ack(steerId));
  await tick();
  assert.deepEqual(steers, [], "a paused turn must leave output for its successor");
  const snapshot = turn.snapshot();
  assert.ok(snapshot);
  const restored = ClaudeLiveTurn.restore(snapshot, collaborators);
  const task = restored.continue();
  push(result());
  await task;
  assert.deepEqual(steers.map(entry => entry.status), ["sent"]);
  assert.deepEqual(log.filter(entry => entry.startsWith("settle")), ["settle:completed"]);
  assert.deepEqual(log.filter(entry => entry === "release"), ["release"]);
  assert.deepEqual(liveUsage.map(entry => entry.window), [300_000, 300_000]);
});

test("a steer consumed without an ack is still delivered from the result's consumed list", async () => {
  const { turn, push, steers } = fixture();
  const { task } = await turn.start("hi");
  turn.steer(steer(), "folded silently");
  push(result({ user_message_uuids: ["first", steerId] }));
  await task;
  assert.deepEqual(steers.map(entry => entry.status), ["sent"]);
});
