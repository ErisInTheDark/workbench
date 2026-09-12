/* Exports: none. Tests protect opposite recency orders without catalogue mutation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchComposerProfile } from "workbench-shared/types";
import { orderComposerProfiles } from "./composer-profile-order";

function profile(id: string, lastUsedAt?: number): WorkbenchComposerProfile {
  return { id, lastUsedAt, name: id, createdAt: 1, updatedAt: 1, scope: { kind: "global" }, harness: "codex", model: "model", agentPath: null, agentSource: null, reasoningEffort: null, serviceTier: null };
}

test("missing usage falls back to edit time while recorded usage wins over newer edits", () => {
  const profiles = [
    profile("newest", 50),
    { ...profile("b"), updatedAt: 30 },
    { ...profile("older", 20), updatedAt: 100 },
    { ...profile("a"), lastUsedAt: null, updatedAt: 30 },
  ];
  const original = [...profiles];
  assert.deepEqual(orderComposerProfiles(profiles, "oldest").map(p => p.id), ["older", "a", "b", "newest"]);
  assert.deepEqual(orderComposerProfiles(profiles, "newest").map(p => p.id), ["newest", "b", "a", "older"]);
  assert.deepEqual(profiles, original);
});
