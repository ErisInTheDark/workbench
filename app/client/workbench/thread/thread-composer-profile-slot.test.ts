/*
 * Tests:
 * - Route identity, not temporary draft-shaped payload ids, selects the daemon composer profile target.
 */
import assert from "node:assert/strict";
import test from "node:test";

import resolveThreadComposerProfileSlot from "./thread-composer-profile-slot";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  DraftId: {
    "11111111-1111-4111-8111-111111111111": fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  },
  WorkbenchThreadId: {
    "route-thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("route-thread"),
  },
};

test("route identity distinguishes blank composers, durable drafts, and provider threads", () => {
  const temporaryDraft = { harness: "codex" as const, id: fixtureIdentitySchemas.DraftIdSchema.parse("draft:temporary"), isDraft: true as const };

  assert.deepEqual(
    resolveThreadComposerProfileSlot(fixtureIdentitySchemas.ProjectIdSchema.parse("project"), { kind: "new" }, temporaryDraft),
    { kind: "new-thread", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
  );
  assert.deepEqual(
    resolveThreadComposerProfileSlot(fixtureIdentitySchemas.ProjectIdSchema.parse("project"), {
      draftId: fixtureIdentityValues.DraftId["11111111-1111-4111-8111-111111111111"],
      kind: "draft",
    }, temporaryDraft),
    {
      draftId: fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111"),
      harness: "codex",
      kind: "draft",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    },
  );
  assert.deepEqual(
    resolveThreadComposerProfileSlot(fixtureIdentitySchemas.ProjectIdSchema.parse("project"), {
      harness: "codex",
      kind: "provider",
      threadId: fixtureIdentityValues.WorkbenchThreadId["route-thread"],
    }, { harness: "opencode", id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("active-thread"), isDraft: false }),
    {
      harness: "opencode",
      kind: "thread",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      threadId: "active-thread",
    },
  );
  assert.deepEqual(
    resolveThreadComposerProfileSlot(fixtureIdentitySchemas.ProjectIdSchema.parse("project"), null, {
      harness: "codex",
      id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("legacy-thread"),
      isDraft: false,
    }),
    {
      harness: "codex",
      kind: "thread",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      threadId: "legacy-thread",
    },
  );
});
