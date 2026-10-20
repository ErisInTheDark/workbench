/* No production exports. Tests protect sidebar rows staying list-rendering only: per-thread detail never rides a row, and subagents fold into their parent's claims instead of listing. */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchThreadIdSchema } from "../identity.ts";
import { projectSidebarRow, projectSidebarRowSnapshot, WorkbenchThreadSidebarRowSchema } from "./thread-sidebar-row.ts";
import type { WorkbenchThreadSidebarEntry } from "./thread-state.ts";

const id = (suffix: number) => WorkbenchThreadIdSchema.parse(`00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`);
const parentId = id(1);

function thread(threadId = parentId): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> {
  return {
    activityAt: 12_000,
    entryKind: "thread",
    gitArc: null,
    gitArcPlan: null,
    gitCommits: [{ commitSha: "d".repeat(40), historyIndex: 0, rootId: "root" }],
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    previousTitles: [{ title: "older title", usedAt: 1 }],
    profile: {
      kind: "custom",
      settings: { agentPath: null, agentSource: null, harness: "codex", model: "gpt", reasoningEffort: null, serviceTier: null },
    },
    title: "heavy",
  };
}

const subagent = (threadId: string, name: string, parentThreadId: string, gitArc: unknown) => ({
  entryKind: "subagent", identity: { harness: "codex", threadId }, name, title: `${name} task`, parentThreadId,
  directSubagentIndex: 0, gitArc,
}) as unknown as WorkbenchThreadSidebarEntry;
const arc = (phase: "active" | "stashed", paths: string[]) => ({
  phase, claimedPaths: phase === "active" ? paths : [], ...(phase === "stashed" ? { stashedPaths: paths } : {}),
});

test("subagents never list as sidebar rows; their parent carries only its direct children's active claims", () => {
  const snapshot = projectSidebarRowSnapshot({
    projectId: "project", revision: 1, freshness: "fresh", error: null, entries: [
      thread(),
      subagent(id(2), "Zed", parentId, arc("active", ["src/b.ts"])),
      subagent(id(3), "Stash", parentId, arc("stashed", ["src/s.ts"])),
      subagent(id(4), "Other", id(9), arc("active", ["src/o.ts"])),
      subagent(id(5), "Idle", parentId, null),
    ],
  } as never);
  assert.deepEqual(snapshot.entries.map(entry => entry.entryKind), ["thread"]);
  const parent = snapshot.entries[0]!;
  assert.deepEqual(parent.entryKind === "thread" ? parent.subagentClaims?.map(({ name, claimedPaths }) => [name, claimedPaths]) : null,
    [["Zed", ["src/b.ts"]]]);
  assert.equal(projectSidebarRowSnapshot(snapshot), snapshot, "folded snapshots re-project by identity, keeping their claims");
});

test("a full thread entry projects to a row without per-thread detail that the strict row schema accepts", () => {
  const row = projectSidebarRow(thread());
  assert.deepEqual(["gitCommits", "previousTitles", "profile"].filter(field => field in row), []);
  assert.equal(WorkbenchThreadSidebarRowSchema.safeParse(row).success, true);
});
