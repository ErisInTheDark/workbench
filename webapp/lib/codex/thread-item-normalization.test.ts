/*
 * Exports:
 * - No production exports; Node tests cover identity-aware user-message normalization and timeline placement. Keywords: thread, user message, normalize, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "./generated/app-server/v2/ThreadItem.ts";
import { normalizeThreadItems } from "./thread-item-normalization.ts";

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
