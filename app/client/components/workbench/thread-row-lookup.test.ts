/* No exports. Protect listed rows keeping their logical and physical source ownership when display keys collide. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchLogicalThreadRow } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { getWorkbenchHomeThreadKey } from "workbench-shared/workbench/thread/home-thread-display-order";
import { threadRowLookup } from "./thread-row-lookup";

test("qualified thread rows retain logical and physical source ownership", () => {
  const shared = {
    activityAt: 1, entryKind: "thread" as const, title: "same display key",
    identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("source") },
    lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const },
    metadata: { archived: false as const, pinned: false, snoozed: false },
  };
  const daemonA = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const daemonB = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
  const logicalA = LogicalProjectIdSchema.parse("00000000-0000-4000-8000-000000000003");
  const logicalB = LogicalProjectIdSchema.parse("00000000-0000-4000-8000-000000000004");
  const physicalProjectId = ProjectIdSchema.parse("project");
  const row = (logicalProjectId: typeof logicalA, daemonId: typeof daemonA): WorkbenchLogicalThreadRow => ({
    entry: shared, hostname: "test", location: { daemonId, projectId: physicalProjectId }, logicalProjectId, rootPath: "C:/repo",
  });
  const first = row(logicalA, daemonA);
  const second = row(logicalB, daemonB);
  const duplicate = row(logicalA, daemonB);
  const lookup = threadRowLookup([first, second, duplicate]);
  assert.equal(lookup.logical.get(getWorkbenchHomeThreadKey(logicalA, shared)), first);
  assert.equal(lookup.logical.get(getWorkbenchHomeThreadKey(logicalB, shared)), second);
  assert.equal(lookup.physical.get(`${daemonB}:${getWorkbenchHomeThreadKey(physicalProjectId, shared)}`), second);
  assert.equal(lookup.physical.get(`${daemonA}:${getWorkbenchHomeThreadKey(physicalProjectId, shared)}`), first);
});
