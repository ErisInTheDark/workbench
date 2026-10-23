/* No production exports. Tests protect which stored items read as user-visible narrative and under which kind. */
import assert from "node:assert/strict";
import test from "node:test";

import { WORKBENCH_THREAD_RECALL_KINDS, type WorkbenchThreadRecallKind } from "workbench-shared/types";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { narrativeRecords, type HistoryNarrativeItem } from "./history-narrative";

const ALL = new Set<WorkbenchThreadRecallKind>(WORKBENCH_THREAD_RECALL_KINDS);

function source(item: ThreadItem, overrides: Partial<HistoryNarrativeItem> = {}): HistoryNarrativeItem {
  return { harness: "codex", inputKind: null, item, opensTurn: true, publicId: "item", threadId: "thread", turnId: "turn", ...overrides };
}

function agent(text: string, phase: "commentary" | "final_answer" | null): ThreadItem {
  return { id: "agent", type: "agentMessage", phase, text, memoryCitation: null, delivery: null, questions: null };
}

function user(text: string): ThreadItem {
  return { id: "user", type: "userMessage", clientId: null, content: [{ type: "text", text, text_elements: [] }] };
}

test("unlabelled assistant prose is hidden for claude and opencode, and reads as commentary for codex", () => {
  for (const harness of ["claude", "opencode"]) {
    assert.deepEqual(narrativeRecords(source(agent("stray prose", null), { harness }), ALL), []);
    assert.equal(narrativeRecords(source(agent("sent to user", "commentary"), { harness }), ALL)[0]?.kind, "commentary");
  }
  assert.equal(narrativeRecords(source(agent("legacy reply", null)), ALL)[0]?.kind, "commentary");
  assert.equal(narrativeRecords(source(agent("done", "final_answer")), ALL)[0]?.kind, "final-answer");
});

test("plans surface on their own only when their parent message kind is not selected, ignoring fenced examples", () => {
  const item = agent("intro\n\n```md\n<plan>\nfenced, not a plan\n</plan>\n```\n\n<plan>\nreal plan\n</plan>", "commentary");
  assert.deepEqual(narrativeRecords(source(item), ALL).map(record => record.kind), ["commentary"]);
  assert.deepEqual(narrativeRecords(source(item), new Set(["plan"])).map(record => [record.ref, record.text]), [["item:plan0", "real plan"]]);
});

test("a turn's opening user message is a message, later ones and stored steers are steers, agent envelopes are agent messages", () => {
  assert.equal(narrativeRecords(source(user("start")), ALL)[0]?.kind, "user-message");
  assert.equal(narrativeRecords(source(user("later"), { opensTurn: false }), ALL)[0]?.kind, "user-steer");
  assert.equal(narrativeRecords(source(user("routed"), { inputKind: "steer" }), ALL)[0]?.kind, "user-steer");
  const envelope = createWorkbenchAgentMessageText({ message: "child done", senderName: "Fern", senderThreadId: "child" });
  const [record] = narrativeRecords(source(user(envelope)), ALL);
  assert.equal(record?.kind, "agent-message");
  assert.match(record?.text ?? "", /Agent message from Fern \(child\)\n\nchild done/u);
});

test("kind selection drops records instead of relabelling them, and non-narrative items never appear", () => {
  assert.deepEqual(narrativeRecords(source(user("start")), new Set(["commentary"])), []);
  assert.deepEqual(narrativeRecords(source({ id: "r", type: "reasoning", summary: ["thinking"], content: [] }), ALL), []);
});
