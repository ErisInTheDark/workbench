/* No exports. Protect source-qualified search thread selection across project routes. */
import assert from "node:assert/strict";
import test from "node:test";

import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchSearchHit } from "../../workbench/search/WorkbenchSearchController";
import type { WorkspaceThreadRows } from "workbench-shared/workbench/workspace/workspace-observation";
import { findSearchThreadEntry, getSearchThreadLocations } from "./WorkbenchSearchDialog";

const projectId = ProjectIdSchema.parse("shared-project");
const otherProjectId = ProjectIdSchema.parse("other-project");
const first = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId };
const second = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId };
const other = { daemonId: DaemonIdSchema.parse(crypto.randomUUID()), projectId: otherProjectId };

function hit(source: typeof first, threadId: string): WorkbenchSearchHit {
  return {
    detail: source.projectId, harnessId: "codex", id: `${source.daemonId}:${threadId}`,
    kind: "thread", projectId: source.projectId, source, threadId, title: threadId,
  };
}

function row(source: typeof first, threadId: string, title: string): WorkspaceThreadRows["rows"][number] {
  return {
    entry: {
      activityAt: 1, entryKind: "thread",
      identity: { harness: "codex", threadId: WorkbenchThreadIdSchema.parse(threadId) },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false }, title,
    },
    hostname: "local", location: source, logicalProjectId: null, rootPath: "/project",
  };
}

test("search demands every hit source and resolves thread rows by daemon and project, not selected project", () => {
  const hits = [hit(first, "same-thread"), hit(second, "same-thread"), hit(other, "other-thread"), hit(second, "same-thread")];
  assert.deepEqual(getSearchThreadLocations(hits), [first, second, other]);

  const rows = [row(first, "same-thread", "first source"), row(second, "same-thread", "second source"),
    row(other, "other-thread", "outside selected project")];
  assert.equal(findSearchThreadEntry(rows, hits[0]!)?.title, "first source");
  assert.equal(findSearchThreadEntry(rows, hits[1]!)?.title, "second source");
  assert.equal(findSearchThreadEntry(rows, hits[2]!)?.title, "outside selected project");
  assert.equal(findSearchThreadEntry(rows, hit(first, "missing")), undefined);
});
