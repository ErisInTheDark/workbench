/* No production exports. Tests protect sidebar rows staying list-rendering only: per-thread detail never rides a row the strict row schema accepts. */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchThreadIdSchema } from "../identity.ts";
import { projectSidebarRow, WorkbenchThreadSidebarRowSchema } from "./thread-sidebar-row.ts";
import type { WorkbenchThreadSidebarEntry } from "./thread-state.ts";

test("a full thread entry projects to a row without per-thread detail that the strict row schema accepts", () => {
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 12_000,
    entryKind: "thread",
    gitArc: null,
    gitArcPlan: null,
    gitCommits: [{ commitSha: "d".repeat(40), historyIndex: 0, rootId: "root" }],
    identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001") },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    previousTitles: [{ title: "older title", usedAt: 1 }],
    profile: {
      kind: "custom",
      settings: { agentPath: null, agentSource: null, harness: "codex", model: "gpt", reasoningEffort: null, serviceTier: null },
    },
    title: "heavy",
  };
  const row = projectSidebarRow(entry);
  assert.deepEqual(["gitCommits", "previousTitles", "profile"].filter(field => field in row), []);
  assert.equal(WorkbenchThreadSidebarRowSchema.safeParse(row).success, true);
});
