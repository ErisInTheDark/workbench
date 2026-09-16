/*
 * Tests:
 * - canonical thread items retain their complete renderer-owned data.
 * - shorthand command fixtures remain convenient and preserve supplied semantic actions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseThreadRenderInput } from "./thread-render-lab-input.ts";

test("thread render lab preserves canonical command actions and user content", () => {
  const commandAction = {
    type: "unknown",
    command: 'wb subagent create --profile profile-id --name Nell --title "Book 1 chapters 60 through 84 note pass" --message "# Read\n\n- **Everything**"',
  } as const;
  const userContent = [{
    type: "text",
    text: "# Canonical Markdown\n\n- **Preserve me**",
    text_elements: [],
  }] as const;
  const result = parseThreadRenderInput(JSON.stringify([
    {
      type: "commandExecution",
      id: "command-1",
      command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "wb subagent create --title \"Book 1 chapters 60 through 84 note pass\""`,
      cwd: "C:/git/stories/Ryn of Avonside",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [commandAction],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    },
    {
      type: "userMessage",
      id: "user-1",
      clientId: null,
      content: userContent,
    },
  ]));

  assert.equal(result.error, "");
  const items = result.thread?.turns[0]?.items;
  assert.ok(items);
  assert.equal(items[0]?.type, "commandExecution");
  if (items[0]?.type === "commandExecution") {
    assert.deepEqual(items[0].commandActions, [commandAction]);
  }
  assert.equal(items[1]?.type, "userMessage");
  if (items[1]?.type === "userMessage") {
    assert.deepEqual(items[1].content, userContent);
  }
});

test("thread render lab adapts shorthand commands without discarding semantic actions", () => {
  const action = {
    type: "unknown",
    command: "wb subagent list --limit 20",
  } as const;
  const result = parseThreadRenderInput(JSON.stringify({
    command: action.command,
    commandActions: [action],
    status: "completed",
  }));

  assert.equal(result.error, "");
  const item = result.thread?.turns[0]?.items[0];
  assert.equal(item?.type, "commandExecution");
  if (item?.type === "commandExecution") {
    assert.equal(item.id, "lab-command-1");
    assert.equal(item.cwd, ".");
    assert.deepEqual(item.commandActions, [action]);
  }
});

test("canonical fixture metadata and interrupted turn failures survive admission", () => {
  const error = { message: "Interrupted", additionalDetails: "detail", codexErrorInfo: null, misalignment: null };
  const history = [{ turnId: "older", loadState: "notLoaded", itemCount: 20 }];
  const result = parseThreadRenderInput(JSON.stringify({
    id: "fixture", harness: "codex", cwd: "/fixture", turns: [{
      id: "turn", items: [], status: "interrupted", error, itemsView: "summary",
    }], turnHistory: history, tokenUsage: { total: 123 },
  }));
  assert.equal(result.error, "");
  assert.equal(result.thread?.turns[0]?.status, "interrupted");
  assert.deepEqual(result.thread?.turns[0]?.error, error);
  assert.equal(result.thread?.turns[0]?.itemsView, "summary");
  assert.deepEqual(result.thread?.turnHistory, history);
  assert.deepEqual(result.thread?.tokenUsage, { total: 123 });
});

test("unsupported entries fail visibly instead of silently shrinking the fixture", () => {
  const result = parseThreadRenderInput(JSON.stringify(["echo keep", { unexpected: true }]));
  assert.ok(result.error);
  assert.equal(result.thread, null);
});

test("empty item arrays are usable empty fixtures", () => {
  const result = parseThreadRenderInput("[]");
  assert.equal(result.error, "");
  assert.deepEqual(result.thread?.turns[0]?.items, []);
});

test("thread envelopes without a harness keep identity and reject malformed turns", () => {
  const result = parseThreadRenderInput('{"id":"custom-fixture","name":"custom","turns":[]}');
  assert.equal(result.thread?.id, "custom-fixture");
  assert.equal(result.thread?.name, "custom");
  assert.ok(parseThreadRenderInput('{"turns":[{"unexpected":true}]}').error);
});
