/* No exports. Protect ordinary waiting and explicit compaction status presentation. */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchThreadSidebarRowSchema } from "workbench-shared/workbench/thread/thread-sidebar-row";
import { describeThreadEntry } from "./thread-entry-presentation";

const base = {
  activityAt: 1,
  entryKind: "thread",
  identity: { harness: "codex", threadId: "00000000-0000-4000-8000-000000000001" },
  metadata: { archived: false, pinned: false, snoozed: false },
  title: "Thread",
  waitingOnThreads: [],
} as const;

test("explicit compaction uses the waiting appearance without borrowing tool-wait state", () => {
  const entry = WorkbenchThreadSidebarRowSchema.parse({
    ...base,
    compacting: true,
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
  });
  const presentation = describeThreadEntry(entry);
  assert.equal(presentation.status, "Compacting");
  assert.equal(presentation.statusTone, "waiting");
  assert.equal(presentation.waiting, true);
});

test("ordinary waits retain their existing label regardless of lifecycle shape", () => {
  const inactive = WorkbenchThreadSidebarRowSchema.parse({
    ...base,
    waitingFor: "other",
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
  });
  assert.equal(describeThreadEntry(inactive).status, "Waiting");
  const active = WorkbenchThreadSidebarRowSchema.parse({
    ...base,
    waitingFor: "other",
    lifecycle: {
      agent: { agentStatus: "working", turnId: "00000000-0000-4000-8000-000000000002" },
      kind: "working", reason: "acceptedIntent", settled: false,
    },
  });
  assert.equal(describeThreadEntry(active).status, "Waiting");
});
