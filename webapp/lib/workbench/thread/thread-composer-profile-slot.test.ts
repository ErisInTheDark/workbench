/*
 * Tests:
 * - Route identity, not temporary draft-shaped payload ids, selects the daemon composer profile target. Keywords: thread, route, composer, profile, target.
 */
import assert from "node:assert/strict";
import test from "node:test";

import resolveThreadComposerProfileSlot from "./thread-composer-profile-slot";

test("route identity distinguishes blank composers, durable drafts, and provider threads", () => {
  const temporaryDraft = { harness: "codex" as const, id: "draft:temporary", isDraft: true };

  assert.deepEqual(
    resolveThreadComposerProfileSlot("project", { kind: "new" }, temporaryDraft),
    { kind: "new-thread", projectId: "project" },
  );
  assert.deepEqual(
    resolveThreadComposerProfileSlot("project", {
      draftId: "11111111-1111-4111-8111-111111111111",
      kind: "draft",
    }, temporaryDraft),
    {
      draftId: "11111111-1111-4111-8111-111111111111",
      harness: "codex",
      kind: "draft",
      projectId: "project",
    },
  );
  assert.deepEqual(
    resolveThreadComposerProfileSlot("project", {
      harness: "codex",
      kind: "provider",
      threadId: "route-thread",
    }, { harness: "opencode", id: "active-thread", isDraft: false }),
    {
      harness: "opencode",
      kind: "thread",
      projectId: "project",
      threadId: "active-thread",
    },
  );
  assert.deepEqual(
    resolveThreadComposerProfileSlot("project", null, {
      harness: "codex",
      id: "legacy-thread",
      isDraft: false,
    }),
    {
      harness: "codex",
      kind: "thread",
      projectId: "project",
      threadId: "legacy-thread",
    },
  );
});
