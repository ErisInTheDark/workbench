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
    assert.equal(item.cwd, "c:/git/web/workbench");
    assert.deepEqual(item.commandActions, [action]);
  }
});
