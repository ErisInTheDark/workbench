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
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  };
}

function waitEntry(
  id: string,
  outcome: ThreadCommandExecutionOutcome,
  targetKeys: readonly string[] = ["name:momo", "name:yuzu"],
  durationMs: number | null = null,
): ThreadSubagentWaitRenderEntry<CommandItem> {
  return {
    item: commandItem(id, durationMs),
    outcome,
    targetKeys,
  };
}

test("folds repeated timeouts into an identical active wait regardless of target order", () => {
  const groups = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout-1", "timedOut"),
    waitEntry("timeout-2", "timedOut", ["name:yuzu", "name:momo"]),
    waitEntry("active", "inProgress", ["name:yuzu", "name:momo"]),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].anchor.item.id, "active");
  assert.deepEqual(groups[0].entries.map((entry) => entry.item.id), ["timeout-1", "timeout-2", "active"]);
});

test("folds a stale active wait into its same-target replacement", () => {
  const groups = groupThreadSubagentWaitRenderEntries([
    waitEntry("stale-active", "inProgress", ["name:momo", "name:yuzu"], 183_000),
    waitEntry("replacement-active", "inProgress", ["name:yuzu", "name:momo"]),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].anchor.item.id, "replacement-active");
  assert.deepEqual(groups[0].entries.map((entry) => entry.item.id), ["stale-active", "replacement-active"]);
  assert.deepEqual(getThreadSubagentWaitTiming(groups[0], []), {
    activeStartedAtMs: null,
    durationMs: 183_000,
  });
});

test("keeps differently targeted active waits in separate groups", () => {
  const groups = groupThreadSubagentWaitRenderEntries([
    waitEntry("momo-active", "inProgress", ["name:momo"]),
    waitEntry("yuzu-active", "inProgress", ["name:yuzu"]),
  ]);

  assert.deepEqual(groups.map((group) => group.entries.map((entry) => entry.item.id)), [
    ["momo-active"],
    ["yuzu-active"],
  ]);
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
    waitEntry("timeout-1", "timedOut", ["name:momo", "name:yuzu"], 61_000),
    waitEntry("timeout-2", "timedOut", ["name:yuzu", "name:momo"], 61_000),
    waitEntry("timeout-3", "timedOut", ["name:momo", "name:yuzu"], 61_000),
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
    waitEntry("momo-1", "timedOut", ["name:momo"]),
    waitEntry("momo-2", "timedOut", ["name:momo"]),
    waitEntry("yuzu-1", "timedOut", ["name:yuzu"]),
    waitEntry("yuzu-2", "timedOut", ["name:yuzu"]),
  ]);

  assert.deepEqual(groups.map((group) => group.entries.map((entry) => entry.item.id)), [
    ["momo-1", "momo-2"],
    ["yuzu-1", "yuzu-2"],
  ]);
});

test("keeps mismatched targets, failures, and declines in separate groups", () => {
  const groups = groupThreadSubagentWaitRenderEntries([
    waitEntry("timeout-a", "timedOut"),
    waitEntry("active-other", "inProgress", ["name:momo"]),
    waitEntry("timeout-b", "timedOut", ["name:yuzu"]),
    waitEntry("failed", "failed", ["name:yuzu"]),
    waitEntry("timeout-c", "timedOut", ["name:momo", "name:yuzu", "name:yuzu"]),
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
