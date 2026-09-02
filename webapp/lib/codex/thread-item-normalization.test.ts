/*
 * Exports:
 * - No production exports; Node tests cover identity-aware normalization and complete provider-scope reconciliation. Keywords: thread, user message, reasoning, provider, normalize, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "./generated/app-server/v2/ThreadItem.ts";
import {
  normalizeThreadItems,
  reconcileCompleteThreadItems,
} from "./thread-item-normalization.ts";

function user(id: string, clientId: string | null, text = "same"): Extract<ThreadItem, { type: "userMessage" }> {
  return { clientId, content: [{ text, text_elements: [], type: "text" }], id, type: "userMessage" };
}

test("normalization preserves distinct identical deliveries", () => {
  const items = [user("canonical-a", "client-a"), user("canonical-b", "client-b")];
  assert.deepEqual(normalizeThreadItems(items).map((item) => item.id), ["canonical-a", "canonical-b"]);
  const generics = [user("item-1", null), user("item-2", null)];
  assert.deepEqual(normalizeThreadItems(generics).map((item) => item.id), ["item-1", "item-2"]);
});

test("a later canonical alias replaces a generic at the later timeline position", () => {
  const divider: ThreadItem = { id: "agent", memoryCitation: null, phase: null, text: "between", type: "agentMessage" };
  const normalized = normalizeThreadItems([user("item-1", null), divider, user("canonical", "client")]);
  assert.deepEqual(normalized.map((item) => item.id), ["agent", "canonical"]);
});

test("same identity lifecycle copies dedupe", () => {
  const divider: ThreadItem = { id: "agent", memoryCitation: null, phase: null, text: "between", type: "agentMessage" };
  const completed = user("canonical", "client", "completed");
  assert.deepEqual(
    normalizeThreadItems([user("canonical", "client", "started"), divider, completed]),
    [completed, divider],
  );
});

test("conflicting identities and distinct canonical ids never content-dedupe", () => {
  assert.deepEqual(
    normalizeThreadItems([user("canonical-a", "client-a"), user("canonical-b", "client-b")]).map((item) => item.id),
    ["canonical-a", "canonical-b"],
  );
  assert.deepEqual(
    normalizeThreadItems([user("provider-a", null), user("provider-b", null)]).map((item) => item.id),
    ["provider-a", "provider-b"],
  );
});

test("optimistic and generic aliases converge only with their concrete delivery", () => {
  const divider: ThreadItem = { id: "agent", memoryCitation: null, phase: null, text: "between", type: "agentMessage" };
  assert.deepEqual(
    normalizeThreadItems([user("optimistic-user-message:steer:pending:one", "client"), divider, user("canonical", "client")]).map((item) => item.id),
    ["agent", "canonical"],
  );
  assert.deepEqual(
    normalizeThreadItems([user("item-1", "client-a"), user("canonical", "client-b")]).map((item) => item.id),
    ["item-1", "canonical"],
  );
});

test("complete provider reconciliation retains canonical narrative identities and prunes stale current items", () => {
  const current: ThreadItem[] = [
    user("msg-user", "client", "hello"),
    { id: "msg-agent", memoryCitation: null, phase: "commentary", text: "working", type: "agentMessage" },
    { id: "plan-canonical", text: "one plan", type: "plan" },
    { id: "stale", memoryCitation: null, phase: null, text: "stale", type: "agentMessage" },
  ];
  const incoming: ThreadItem[] = [
    user("item-1", "client", "hello"),
    { id: "item-2", memoryCitation: null, phase: "commentary", text: "working", type: "agentMessage" },
    { id: "item-3", text: "one plan", type: "plan" },
    { id: "new", memoryCitation: null, phase: "final_answer", text: "done", type: "agentMessage" },
  ];

  const reconciled = reconcileCompleteThreadItems(current, incoming);
  assert.deepEqual(
    reconciled.map(({ aliases, incomingItemId, item }) => ({
      aliases,
      incomingItemId,
      itemId: item.id,
    })),
    [
      { aliases: ["item-1"], incomingItemId: "item-1", itemId: "msg-user" },
      { aliases: ["item-2"], incomingItemId: "item-2", itemId: "msg-agent" },
      { aliases: ["item-3"], incomingItemId: "item-3", itemId: "plan-canonical" },
      { aliases: [], incomingItemId: "new", itemId: "new" },
    ],
  );
});

test("complete provider reconciliation preserves granular canonical reasoning and emits only snapshot residue", () => {
  const current: ThreadItem[] = [
    { content: [], id: "rs-a", summary: ["alpha"], type: "reasoning" },
    { content: ["beta"], id: "rs-b", summary: [], type: "reasoning" },
    { content: [], id: "rs-stale", summary: ["stale"], type: "reasoning" },
  ];
  const incoming: ThreadItem[] = [{
    content: ["beta", "gamma"],
    id: "item-4",
    summary: ["alpha"],
    type: "reasoning",
  }];

  const reconciled = reconcileCompleteThreadItems(current, incoming);
  assert.deepEqual(reconciled.map(({ aliases, incomingItemId, item }) => ({
    aliases,
    content: item.type === "reasoning" ? item.content : [],
    incomingItemId,
    itemId: item.id,
    summary: item.type === "reasoning" ? item.summary : [],
  })), [
    { aliases: [], content: [], incomingItemId: "item-4", itemId: "rs-a", summary: ["alpha"] },
    { aliases: [], content: ["beta"], incomingItemId: "item-4", itemId: "rs-b", summary: [] },
    { aliases: [], content: ["", "gamma"], incomingItemId: "item-4", itemId: "item-4", summary: [""] },
  ]);
});

test("complete provider reconciliation preserves conflicting user identities", () => {
  const reconciled = reconcileCompleteThreadItems(
    [user("canonical", "client-a")],
    [user("item-1", "client-b")],
  );
  assert.deepEqual(reconciled.map(({ item }) => item.id), ["item-1"]);
});
