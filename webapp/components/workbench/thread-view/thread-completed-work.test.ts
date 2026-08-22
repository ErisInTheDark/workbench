/*
 * Exports:
 * - No production exports; Node tests protect completed-turn status boundaries, terminal output, legacy fallback, and worked timing. Keywords: thread, completed, worked, terminal, status, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import { partitionCompletedThreadWork } from "./thread-completed-work";

function commandItem({
  command,
  exitCode = 0,
  id,
  status = "completed",
}: {
  command: string;
  exitCode?: number | null;
  id: string;
  status?: Extract<ThreadItem, { type: "commandExecution" }>["status"];
}): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    aggregatedOutput: null,
    command,
    commandActions: [],
    cwd: "C:/workspace",
    durationMs: null,
    exitCode,
    id,
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status,
    type: "commandExecution",
  };
}

const userItem = {
  clientId: null,
  content: [],
  id: "user",
  type: "userMessage",
} as const satisfies ThreadItem;
const finalItem = {
  id: "final",
  memoryCitation: null,
  phase: "final_answer",
  text: "done",
  type: "agentMessage",
} as const satisfies ThreadItem;

test("the last successful task status starts always-mounted terminal output", () => {
  const firstStatus = commandItem({ command: "wb thread status --status completed", id: "first-status" });
  const correction = commandItem({ command: "pnpm test", id: "correction" });
  const lastStatus = commandItem({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'wb thread status --status blocked'`,
    id: "last-status",
  });
  const proposal = commandItem({ command: "wb git arc propose -m Done", id: "proposal" });
  const partition = partitionCompletedThreadWork({
    finalAgentMessageId: finalItem.id,
    itemTimeline: [
      { completedAt: 500, firstSeenAt: 100, itemId: firstStatus.id, lastSeenAt: 500, startedAt: 100 },
      { completedAt: 900, firstSeenAt: 600, itemId: correction.id, lastSeenAt: 900, startedAt: 600 },
      { completedAt: 1_500, firstSeenAt: 1_000, itemId: lastStatus.id, lastSeenAt: 1_500, startedAt: 1_000 },
      { completedAt: 2_000, firstSeenAt: 1_600, itemId: proposal.id, lastSeenAt: 2_000, startedAt: 1_600 },
    ],
    items: [userItem, firstStatus, correction, lastStatus, proposal, finalItem],
    primaryUserItemId: userItem.id,
  });

  assert.equal(partition.statusMarkerId, lastStatus.id);
  assert.deepEqual(partition.workedItems.map((item) => item.id), [firstStatus.id, correction.id]);
  assert.deepEqual(partition.terminalItems.map((item) => item.id), [lastStatus.id, proposal.id, finalItem.id]);
  assert.equal(partition.workedDurationMs, 800);
});

test("failed and in-progress task status commands do not create a terminal boundary", () => {
  const failed = commandItem({ command: "wb thread status --status completed", exitCode: 1, id: "failed", status: "failed" });
  const running = commandItem({ command: "wb thread status --status blocked", exitCode: null, id: "running", status: "inProgress" });
  const partition = partitionCompletedThreadWork({
    finalAgentMessageId: finalItem.id,
    items: [userItem, failed, running, finalItem],
    primaryUserItemId: userItem.id,
  });

  assert.equal(partition.statusMarkerId, null);
  assert.deepEqual(partition.workedItems.map((item) => item.id), [failed.id, running.id]);
  assert.deepEqual(partition.terminalItems.map((item) => item.id), [finalItem.id]);
  assert.equal(partition.workedDurationMs, null);
});

test("marker-less turns preserve the legacy final-message fallback", () => {
  const work = commandItem({ command: "pnpm typecheck", id: "work" });
  const partition = partitionCompletedThreadWork({
    finalAgentMessageId: finalItem.id,
    items: [userItem, work, finalItem],
    primaryUserItemId: userItem.id,
  });

  assert.deepEqual(partition.workedItems.map((item) => item.id), [work.id]);
  assert.deepEqual(partition.terminalItems.map((item) => item.id), [finalItem.id]);
});
