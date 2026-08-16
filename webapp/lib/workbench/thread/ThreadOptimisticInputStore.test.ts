/*
 * Exports:
 * - No production exports; Node tests cover optimistic steer/initial identity, delivery placement, and history reconciliation. Keywords: optimistic, steer, initial, delivery, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";
import type { ThreadPayload, WorkbenchSteerHistoryEntry } from "../../types.ts";
import ThreadOptimisticInputStore from "./ThreadOptimisticInputStore.ts";
import { applySteerHistoryToThread } from "./thread-steer-history.ts";

function input(text: string) {
  return [{ text, text_elements: [], type: "text" as const }];
}

function user(id: string, clientId: string | null, text: string): Extract<ThreadItem, { type: "userMessage" }> {
  return { clientId, content: input(text), id, type: "userMessage" };
}

function thread(items: ThreadItem[] = []): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    forkedFromId: null, harness: "codex", id: "thread", isDraft: false, model: null, name: null, path: null, preview: "",
    reasoningEffort: null, serviceTier: null, source: "codex", status: "active", tokenUsage: null, turnHistory: [], unreadBadge: null,
    turns: [{ completedAt: null, durationMs: null, error: null, id: "turn", items, itemsView: "full", startedAt: 1, status: "inProgress" }], updatedAt: 1,
  };
}

function history(handle: string, status: WorkbenchSteerHistoryEntry["status"], canonicalItemId: string | null = null): WorkbenchSteerHistoryEntry {
  return {
    attemptedAt: 1, canonicalItemId, clientUserMessageId: handle, dispatchSequence: 0, entryKey: `turn-steer-client:${handle}`,
    error: null, input: input("same"), requestId: "1", resolvedAt: status === "pending" ? null : 2, status,
    threadId: "thread", turnId: "turn",
  };
}

test("two identical steers retain independent handles and canonical placement", () => {
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => ids.shift()! });
  const first = store.enqueueSteer(thread(), "turn", input("same"));
  const second = store.enqueueSteer(thread(), "turn", input("same"));
  assert.notEqual(first.handle, second.handle);
  assert.deepEqual(store.apply(thread(), []).turns[0]?.items.map((item) => item.type === "userMessage" ? item.clientId : null), [first.handle, second.handle]);

  const canonical = user("canonical-a", first.handle, "same");
  assert.equal(store.confirmCanonicalUserMessage("codex:thread", "turn", canonical), first.handle);
  const projected = store.apply(thread([{ id: "agent", memoryCitation: null, phase: null, text: "work", type: "agentMessage" }, canonical]), []);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.id), ["agent", "canonical-a", second.item.id]);
  assert.equal(store.movePending(first.handle, "other-turn"), false);
});

test("canonical initial input retains its leading user-message position", () => {
  const store = ThreadOptimisticInputStore();
  const agent: ThreadItem = { id: "agent", memoryCitation: null, phase: null, text: "work", type: "agentMessage" };
  store.enqueueInitial(thread([agent]), "turn", input("initial"), { status: "sent" });
  const projected = store.apply(thread([agent, user("canonical", null, "initial")]), []);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.id), ["canonical", "agent"]);
});

test("native initial identity collapses only its exact canonical alias", () => {
  const store = ThreadOptimisticInputStore();
  const clientUserMessageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const entry = store.enqueueInitial(thread(), "turn", input("same"), { clientUserMessageId, status: "sent" });
  assert.equal(entry.item.clientId, clientUserMessageId);
  const canonical = user("canonical", clientUserMessageId, "same");
  store.confirmCanonicalUserMessage("codex:thread", "turn", canonical);
  const projected = store.apply(thread([canonical]), []);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.id), ["canonical"]);
});

test("identical initial messages with different native identities remain distinct", () => {
  const store = ThreadOptimisticInputStore();
  const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  store.enqueueInitial(thread(), "turn", input("same"), { clientUserMessageId: firstId, status: "sent" });
  store.enqueueInitial(thread(), "turn", input("same"), { clientUserMessageId: secondId, status: "sent" });
  const projected = store.apply(thread([user("first", firstId, "same"), user("second", secondId, "same")]), []);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.id), ["first", "second"]);
});

test("exact pending history suppresses only its matching local placeholder", () => {
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => ids.shift()! });
  const first = store.enqueueSteer(thread(), "turn", input("same"));
  const second = store.enqueueSteer(thread(), "turn", input("same"));
  const entries = [history(first.handle, "pending"), { ...history(second.handle, "pending"), dispatchSequence: 1 }];
  const withHistory = applySteerHistoryToThread(thread(), entries);
  const projected = store.apply(withHistory, entries);
  assert.equal(projected.turns[0]?.items.length, 2);
  assert.ok(projected.turns[0]?.items.every((item) => item.id.startsWith("workbench:steer-history:")));
});

test("sent is monotonic against delayed failure and aliases stay on one handle", () => {
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const entry = store.enqueueSteer(thread(), "turn", input("same"));
  store.confirmCanonicalUserMessage("codex:thread", "turn", user("generic", entry.handle, "same"));
  store.confirmCanonicalUserMessage("codex:thread", "turn", user("canonical", entry.handle, "same"));
  assert.equal(store.transition(entry.handle, "failed"), "sent");
  const projected = store.apply(thread([user("canonical", entry.handle, "same")]), []);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.id), ["canonical"]);
});

test("interrupted is monotonic against a delayed failure but canonical delivery still wins", () => {
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const entry = store.enqueueSteer(thread(), "turn", input("same"));
  assert.equal(store.transition(entry.handle, "interrupted"), "interrupted");
  assert.equal(store.transition(entry.handle, "failed"), "interrupted");
  store.confirmCanonicalUserMessage("codex:thread", "turn", user("canonical", entry.handle, "same"));
  assert.equal(store.transition(entry.handle, "failed"), "sent");
});

test("clear does not reuse local handles and deleteThread is exact-key scoped", () => {
  const store = ThreadOptimisticInputStore();
  const first = store.enqueueInitial(thread(), "turn", input("first"));
  store.clear();
  const second = store.enqueueInitial(thread(), "turn", input("second"));
  assert.notEqual(first.handle, second.handle);
  const other = { ...thread(), id: "other" };
  store.enqueueInitial(other, "turn", input("other"));
  store.deleteThread("codex:thread");
  assert.equal(store.apply(thread(), []).turns[0]?.items.length, 0);
  assert.equal(store.apply(other, []).turns[0]?.items.length, 1);
});

test("exact terminal history hides only its own correlated local evidence", () => {
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => ids.shift()! });
  const failed = store.enqueueSteer(thread(), "turn", input("same"));
  const pending = store.enqueueSteer(thread(), "turn", input("same"));
  const projected = store.apply(thread(), [history(failed.handle, "failed")]);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.type === "userMessage" ? item.clientId : null), [pending.handle]);
});

test("sent history without a raw canonical item retains one sent local projection", () => {
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const entry = store.enqueueSteer(thread(), "turn", input("same"));
  const projected = store.apply(thread(), [history(entry.handle, "sent", "canonical")]);
  assert.equal(projected.turns[0]?.items.length, 1);
  assert.match(projected.turns[0]?.items[0]?.id ?? "", /:sent:/u);

  const withCanonical = store.apply(
    thread([user("canonical", entry.handle, "same")]),
    [history(entry.handle, "sent", "canonical")],
  );
  assert.deepEqual(withCanonical.turns[0]?.items.map((item) => item.id), ["canonical"]);
});

test("movePending preserves identity and refuses terminal entries", () => {
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const entry = store.enqueueSteer(thread(), "turn", input("same"));
  assert.equal(store.movePending(entry.handle, "other"), true);
  store.transition(entry.handle, "failed");
  assert.equal(store.movePending(entry.handle, "third"), false);
});

test("strip and apply keep optimistic presentation out of raw source", () => {
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  store.enqueueSteer(thread(), "turn", input("same"));
  const projected = store.apply(thread(), []);
  assert.equal(projected.turns[0]?.items.length, 1);
  assert.equal(store.strip(projected).turns[0]?.items.length, 0);
});

test("repeated canonical evidence cannot consume a later identical retry", () => {
  const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
  const store = ThreadOptimisticInputStore({ createClientUserMessageId: () => ids.shift()! });
  const first = store.enqueueSteer(thread(), "turn", input("same"));
  const second = store.enqueueSteer(thread(), "turn", input("same"));
  const canonical = user("canonical", first.handle, "same");
  store.confirmCanonicalUserMessage("codex:thread", "turn", canonical);
  store.confirmCanonicalUserMessage("codex:thread", "turn", canonical);
  const projected = store.apply(thread([canonical]), []);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.type === "userMessage" ? item.clientId : null), [first.handle, second.handle]);
});

test("failed provider attempt stays visible while canonical content settles its retry", () => {
  const provider = { ...thread(), harness: "copilot" as const, source: "copilot" };
  const store = ThreadOptimisticInputStore();
  const failed = store.enqueueSteer(provider, "turn", input("same"), "failed");
  store.enqueueSteer(provider, "turn", input("same"));
  const projected = store.apply({ ...provider, turns: [{ ...provider.turns[0]!, items: [user("canonical", null, "same")] }] }, []);
  assert.deepEqual(projected.turns[0]?.items.map((item) => item.id), ["canonical", failed.item.id]);
});
