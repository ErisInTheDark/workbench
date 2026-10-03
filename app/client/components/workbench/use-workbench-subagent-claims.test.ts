import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import { collectSubagentClaims } from "./use-workbench-subagent-claims.ts";

const gitArc = (phase: "active" | "stashed", paths: string[]) => ({
  phase, claimedPaths: phase === "active" ? paths : [], ...(phase === "stashed" ? { stashedPaths: paths } : {}),
}) as never;

const child = (threadId: string, name: string, parentThreadId: string, arc: unknown) => ({
  entryKind: "subagent", identity: { harness: "codex", threadId }, name, parentThreadId, gitArc: arc,
}) as unknown as WorkbenchThreadSidebarEntry;

test("parent claim rollups include only its direct children's active claims", () => {
  const entries = [
    child("b", "Zed", "parent", gitArc("active", ["src/b.ts"])),
    child("a", "Iris", "parent", gitArc("active", ["src/a.ts", "src/c.ts"])),
    child("s", "Stash", "parent", gitArc("stashed", ["src/s.ts"])),
    child("o", "Other", "someone-else", gitArc("active", ["src/o.ts"])),
    child("n", "Idle", "parent", null),
  ];
  assert.deepEqual(collectSubagentClaims(entries, "parent").map(({ name, claimedPaths }) => [name, claimedPaths]), [
    ["Iris", ["src/a.ts", "src/c.ts"]],
    ["Zed", ["src/b.ts"]],
  ]);
  assert.deepEqual(collectSubagentClaims(entries, "nobody"), []);
});
