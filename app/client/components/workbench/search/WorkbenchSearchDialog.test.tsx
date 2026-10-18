/* No exports. Protect source-qualified search thread selection across project routes. */
import assert from "node:assert/strict";
import test from "node:test";

import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchSearchHit } from "../../../workbench/search/WorkbenchSearchController";
import type { WorkspaceThreadSummary } from "workbench-shared/workbench/workspace/workspace-observation";
import { findSearchThreadEntry } from "./WorkbenchSearchDialog";

const projectId = ProjectIdSchema.parse("shared-project");
const first = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId };
const second = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId };

function hit(source: typeof first, threadId: string): WorkbenchSearchHit {
  return {
    detail: source.projectId, harnessId: "codex", id: `${source.daemonId}:${threadId}`,
    kind: "thread", projectId: source.projectId, source, threadId, title: threadId,
  };
}

function summary(source: typeof first, threadId: string, title: string): WorkspaceThreadSummary {
  return {
    location: source, logicalProjectId: null,
    summary: { facts: {}, row: {
      activityAt: 1, entryKind: "thread",
      identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(threadId) },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false }, title,
    } },
  };
}

test("a thread hit resolves from its summary only where the summary lives at the hit's source", () => {
  const summaries = new Map([["thread", summary(first, "thread", "first source")]]);
  const read = (threadId: string) => summaries.get(threadId) ?? null;
  assert.equal(findSearchThreadEntry(read, hit(first, "thread"))?.title, "first source");
  assert.equal(findSearchThreadEntry(read, hit(second, "thread")), undefined, "another daemon's hit never borrows this row");
  assert.equal(findSearchThreadEntry(read, hit(first, "missing")), undefined);
});
