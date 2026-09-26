/* No production exports. Protect project-qualified Home member ownership during legacy import. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "../workbench/identity.ts";
import { getWorkbenchHomeThreadKey } from "../workbench/thread/home-thread-display-order.ts";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadSidebarSnapshot } from "../workbench/thread/thread-state.ts";
import { homeLegacyPresentationLayout } from "./workbench-presentation-legacy-layout.ts";

test("legacy Home import keeps identical thread ids distinct across project locations", () => {
  const daemonId = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
  const first = ProjectIdSchema.parse("first");
  const second = ProjectIdSchema.parse("second");
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, entryKind: "thread",
    identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse("same-thread") },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    orderAt: 1, title: "same title",
  };
  const sidebar = (projectId: typeof first): WorkbenchThreadSidebarSnapshot => ({
    displayOrder: {}, entries: [{ ...entry }], error: null, freshness: "fresh", projectId, revision: 1,
  });
  const sourceId = `home:${getWorkbenchHomeThreadKey(first, entry)}`;
  const layout = homeLegacyPresentationLayout({
    daemonId, sidebars: { projects: [sidebar(first), sidebar(second)] },
    displayOrder: {}, sourceRevision: 1,
    mappings: [{ daemonId, sourceKind: "member", sourceId, targetId: "00000000-0000-4000-8000-000000000009", sourceRevision: 1 }],
  });
  assert.equal(layout.members.length, 2);
  assert.deepEqual(new Set(layout.members.map(member => member.thread?.location.projectId)), new Set([first, second]));
  assert.equal(layout.members.find(member => member.sourceId === sourceId)?.id, "00000000-0000-4000-8000-000000000009");
});
