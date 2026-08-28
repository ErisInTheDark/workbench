/*
 * Exports:
 * - No production exports; Node tests protect CLI/MCP completed-turn status boundaries, terminal output, legacy fallback, and worked timing. Keywords: thread, completed, worked, terminal, status, MCP, test.
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

function mcpStatusItem({
  agentStatus = "completed",
  id,
  status = "completed",
}: {
  agentStatus?: "blocked" | "completed";
  id: string;
  status?: Extract<ThreadItem, { type: "mcpToolCall" }>["status"];
}): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return {
    appContext: null,
    arguments: { status: agentStatus },
    durationMs: 12,
    error: status === "failed" ? { message: "status failed" } : null,
    id,
    pluginId: null,
    readOnlyHint: false,
    result: status === "completed" ? { _meta: null, content: [{ type: "text", text: `Thread status set: ${agentStatus}` }], structuredContent: null } : null,
    server: "wb",
    status,
    tool: "thread_status",
    type: "mcpToolCall",
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
  const proposal = commandItem({ command: "wb git arc propose --title Done", id: "proposal" });
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

test("a successful wb MCP task status starts always-mounted terminal output", () => {
  for (const agentStatus of ["completed", "blocked"] as const) {
    const work = commandItem({ command: "pnpm test", id: "work" });
    const status = mcpStatusItem({ agentStatus, id: `mcp-status-${agentStatus}` });
    const proposal = commandItem({ command: "wb git arc propose --title Done", id: "proposal" });
    const partition = partitionCompletedThreadWork({
      finalAgentMessageId: finalItem.id,
      items: [userItem, work, status, proposal, finalItem],
      primaryUserItemId: userItem.id,
    });

    assert.equal(partition.statusMarkerId, status.id);
    assert.deepEqual(partition.workedItems.map((item) => item.id), [work.id]);
    assert.deepEqual(partition.terminalItems.map((item) => item.id), [status.id, proposal.id, finalItem.id]);
  }
});

test("failed and in-progress task status commands do not create a terminal boundary", () => {
  const failed = commandItem({ command: "wb thread status --status completed", exitCode: 1, id: "failed", status: "failed" });
  const running = commandItem({ command: "wb thread status --status blocked", exitCode: null, id: "running", status: "inProgress" });
  const partition = partitionCompletedThreadWork({
    finalAgentMessageId: finalItem.id,
    items: [userItem, failed, running, mcpStatusItem({ id: "mcp-failed", status: "failed" }), mcpStatusItem({ id: "mcp-running", status: "inProgress" }), finalItem],
    primaryUserItemId: userItem.id,
  });

  assert.equal(partition.statusMarkerId, null);
  assert.deepEqual(partition.workedItems.map((item) => item.id), [failed.id, running.id, "mcp-failed", "mcp-running"]);
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
