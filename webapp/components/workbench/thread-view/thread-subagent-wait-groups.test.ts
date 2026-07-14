/*
 * Exports:
 * - No production exports; Node tests cover UI-only subagent wait folding and cumulative duration derivation. Keywords: thread, subagent, wait, timeout, duration, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { ThreadCommandExecutionOutcome } from "../../../lib/workbench/thread/thread-command-matchers";
import {
  getThreadSubagentWaitTiming,
  groupThreadSubagentWaitRenderEntries,
  type ThreadSubagentWaitRenderEntry,
} from "./thread-subagent-wait-groups";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

function commandItem(id: string, durationMs: number | null = null): CommandItem {
  return {
    aggregatedOutput: null,
    command: `wb subagent wait --id ${id}`,
    commandActions: [],
    cwd: "C:/git/web/workbench",
    durationMs,
    exitCode: null,
    id,
    processId: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  };
}

function waitEntry(
  id: string,
  outcome: ThreadCommandExecutionOutcome,
  threadIds: readonly string[] = ["Momo", "Yuzu"],
  durationMs: number | null = null,
): ThreadSubagentWaitRenderEntry<CommandItem> {
  return {
    item: commandItem(id, durationMs),
    outcome,
    threadIds,
  };
}

test("folds repeated timeouts into an identical active wait regardless of target order", () => {
  const groups = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout-1", "timedOut"),
    waitEntry("timeout-2", "timedOut", ["Yuzu", "Momo"]),
    waitEntry("active", "inProgress", ["Yuzu", "Momo"]),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].anchor.item.id, "active");
  assert.deepEqual(groups[0].entries.map((entry) => entry.item.id), ["timeout-1", "timeout-2", "active"]);
});

test("folds timeouts into a successful wait and preserves the successful anchor", () => {
  const groups = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout-1", "timedOut"),
    waitEntry("success", "completed"),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].anchor.item.id, "success");
});

test("folds a terminal run of identical timeouts into its final timeout", () => {
  const [group] = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout-1", "timedOut", ["Momo", "Yuzu"], 61_000),
    waitEntry("timeout-2", "timedOut", ["Yuzu", "Momo"], 61_000),
    waitEntry("timeout-3", "timedOut", ["Momo", "Yuzu"], 61_000),
  ]);

  assert.equal(group.anchor.item.id, "timeout-3");
  assert.deepEqual(group.entries.map((entry) => entry.item.id), ["timeout-1", "timeout-2", "timeout-3"]);
  assert.deepEqual(getThreadSubagentWaitTiming(group, []), {
    activeStartedAtMs: null,
    durationMs: 183_000,
  });
});

test("keeps differently targeted timeout runs in separate groups", () => {
  const groups = groupThreadSubagentWaitRenderEntries([
    waitEntry("momo-1", "timedOut", ["Momo"]),
    waitEntry("momo-2", "timedOut", ["Momo"]),
    waitEntry("yuzu-1", "timedOut", ["Yuzu"]),
    waitEntry("yuzu-2", "timedOut", ["Yuzu"]),
  ]);

  assert.deepEqual(groups.map((group) => group.entries.map((entry) => entry.item.id)), [
    ["momo-1", "momo-2"],
    ["yuzu-1", "yuzu-2"],
  ]);
});

test("keeps mismatched targets, failures, and declines in separate groups", () => {
  const groups = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout-a", "timedOut"),
    waitEntry("active-other", "inProgress", ["Momo"]),
    waitEntry("timeout-b", "timedOut", ["Yuzu"]),
    waitEntry("failed", "failed", ["Yuzu"]),
    waitEntry("timeout-c", "timedOut", ["Momo", "Yuzu", "Yuzu"]),
    waitEntry("declined", "declined"),
  ]);

  assert.deepEqual(groups.map((group) => group.entries.map((entry) => entry.item.id)), [
    ["timeout-a"],
    ["active-other"],
    ["timeout-b"],
    ["failed"],
    ["timeout-c"],
    ["declined"],
  ]);
});

test("derives frozen cumulative duration from every folded attempt", () => {
  const [group] = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout-1", "timedOut", undefined, 120_100),
    waitEntry("timeout-2", "timedOut", undefined, 120_200),
    waitEntry("success", "completed", undefined, 9_500),
  ]);

  assert.deepEqual(getThreadSubagentWaitTiming(group, []), {
    activeStartedAtMs: null,
    durationMs: 249_800,
  });
});

test("derives live cumulative timing from settled attempts and the active timeline start", () => {
  const [group] = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout", "timedOut", undefined, 120_100),
    waitEntry("active", "inProgress"),
  ]);

  assert.deepEqual(getThreadSubagentWaitTiming(group, [{
    completedAt: null,
    firstSeenAt: 1_999,
    itemId: "active",
    lastSeenAt: 2_100,
    startedAt: 2_000,
  }]), {
    activeStartedAtMs: 2_000,
    durationMs: 120_100,
  });
});

test("falls back to timeline ranges when a settled command duration is missing", () => {
  const [group] = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout", "timedOut"),
    waitEntry("success", "completed", undefined, 500),
  ]);

  assert.deepEqual(getThreadSubagentWaitTiming(group, [{
    completedAt: 121_000,
    firstSeenAt: 900,
    itemId: "timeout",
    lastSeenAt: 121_100,
    startedAt: 1_000,
  }]), {
    activeStartedAtMs: null,
    durationMs: 120_500,
  });
});
