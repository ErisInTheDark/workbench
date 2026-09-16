/* No exports. Protect started-command visibility and reasoning-first live summary selection. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { getLiveThreadActivity, getThreadTerminalEntries } from "./thread-live-activity";
import { getThreadCommandBlockDisplay } from "../../../workbench/thread/thread-command-matchers";

function command(id: string, status: "inProgress" | "completed" = "inProgress"): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    id, type: "commandExecution", command: `cat ${id}.txt`, commandActions: [], cwd: "/project",
    status, aggregatedOutput: null, durationMs: null, exitCode: null, processId: null,
    pluginId: null, scriptPath: null, source: "agent",
  };
}
function turn(items: ThreadItem[]): Turn {
  return { id: "turn", status: "inProgress", items, itemsView: "full", error: null, startedAt: 0, completedAt: null, durationMs: null };
}

test("started commands with no output are admitted alongside completed history", () => {
  const entries = getThreadTerminalEntries([command("first", "completed"), command("second")], { cwd: "/project" });
  assert.deepEqual(entries.map(entry => [entry.id, entry.status, entry.output]), [
    ["first", "completed", ""], ["second", "inProgress", ""],
  ]);
});

test("ongoing summaries aggregate only running commands through the matcher owner", () => {
  const items = [command("done", "completed"), command("a"), command("b")];
  const commands = getThreadTerminalEntries(items, { cwd: "/project" });
  const live = getLiveThreadActivity({ commands, turn: turn(items), pendingUserInputRequest: null });
  const expected = getThreadCommandBlockDisplay({ items: commands.slice(1).map(entry => ({ display: entry.display! })) });
  assert.equal(live?.kind, "commands");
  assert.equal(live?.title, expected.ongoingSummaryText);
});

test("current reasoning takes priority without removing commands from the terminal projection", () => {
  const items: ThreadItem[] = [command("running"), { id: "reasoning", type: "reasoning", summary: ["**Considering the result**\nMore detail."], content: [] }];
  const commands = getThreadTerminalEntries(items, { cwd: "/project" });
  const live = getLiveThreadActivity({ commands, turn: turn(items), pendingUserInputRequest: null });
  assert.equal(live?.kind, "reasoning");
  assert.equal(commands.length, 1);
});

test("unmatched MCP calls remain visible before results and retain raw invocation and error text", () => {
  const item: Extract<ThreadItem, { type: "mcpToolCall" }> = {
    id: "mcp", type: "mcpToolCall", server: "custom", tool: "frobnicate", arguments: { path: "a" },
    status: "inProgress", durationMs: null, result: null, error: null,
    appContext: null, pluginId: null, readOnlyHint: null,
  };
  const entries = getThreadTerminalEntries([item], { cwd: "/project" });
  assert.equal(entries.length, 1);
  assert.match(entries[0]!.command, /frobnicate/u);
  assert.equal(getLiveThreadActivity({ commands: entries, turn: turn([item]), pendingUserInputRequest: null })?.kind, "commands");
  const failed = getThreadTerminalEntries([{ ...item, status: "failed", error: { message: "Unable to read" } }], { cwd: "/project" });
  assert.equal(failed[0]!.output, "Unable to read");
  assert.equal(failed[0]!.status, "failed");
});

test("partial output keeps commands running and terminal turns do not show a live status", () => {
  const item = { ...command("stream"), aggregatedOutput: "partial" };
  const entries = getThreadTerminalEntries([item], { cwd: "/project" });
  assert.equal(entries[0]!.status, "inProgress");
  assert.equal(getLiveThreadActivity({ commands: entries, turn: { ...turn([item]), status: "completed" }, pendingUserInputRequest: null }), null);
});

test("terminal history keeps old running calls but intersects completed age and invocation limits", () => {
  const now = 4_000_000;
  const items = [command("old-running"), ...Array.from({ length: 25 }, (_, index) => command(`done-${index}`, "completed"))];
  const itemTimeline = items.map((item, index) => ({
    itemId: item.id, startedAt: index === 0 || index === 25 ? now - 1_800_000 : now - 100,
    firstSeenAt: null, completedAt: null, lastSeenAt: null,
  }));
  const entries = getThreadTerminalEntries(items, { cwd: "/project", retention: { now, itemTimeline } });
  assert.deepEqual(entries.map(entry => entry.id), ["old-running", ...items.slice(6, 25).map(item => item.id)]);
  const completed = getThreadTerminalEntries([{ ...items[0], status: "completed" } as ThreadItem, ...items.slice(1)],
    { cwd: "/project", retention: { now, itemTimeline } });
  assert.equal(completed.some(entry => entry.id === "old-running"), false);
});

test("terminal retention uses first observation or turn time without refreshing unknown ages", () => {
  const items = [command("observed", "completed"), command("turn", "completed"), command("running")];
  const entries = getThreadTerminalEntries(items, {
    cwd: "/project",
    retention: {
      now: 4_000_000, turnStartedAt: 1_000,
      itemTimeline: [{ itemId: "observed", startedAt: null, firstSeenAt: 3_999_000, completedAt: null, lastSeenAt: null }],
    },
  });
  assert.deepEqual(entries.map(entry => entry.id), ["observed", "running"]);
  const unknown = getThreadTerminalEntries(Array.from({ length: 30 }, (_, index) => command(String(index), "completed")),
    { cwd: "/project", retention: { now: 4_000_000 } });
  assert.deepEqual(unknown.map(entry => entry.id), Array.from({ length: 20 }, (_, index) => String(index + 10)));
});

test("discarded terminal history never formats its output and running summaries need no output", () => {
  const discarded = { ...command("discarded", "completed"), get aggregatedOutput(): string { throw new Error("discarded output accessed"); } };
  assert.equal(getThreadTerminalEntries([discarded], {
    cwd: "/project", retention: { now: 4_000_000, turnStartedAt: 1_000 },
  }).length, 0);
  const running = { ...command("running"), get aggregatedOutput(): string { throw new Error("summary output accessed"); } };
  assert.equal(getThreadTerminalEntries([running], { cwd: "/project", includeOutput: false }).length, 1);
});

test("terminal expiry follows a reported failure even when the provider status still says running", () => {
  const failed = { ...command("failed"), exitCode: 1 };
  assert.deepEqual(getThreadTerminalEntries([failed], {
    cwd: "/project", retention: { now: 4_000_000, turnStartedAt: 1_000 },
  }), []);
});
