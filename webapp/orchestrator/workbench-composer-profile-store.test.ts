/*
 * Exports:
 * - No production exports; Node tests cover durable composer-profile mutation semantics. Keywords: composer, profile, durable, store, test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { WorkbenchComposerProfile } from "../lib/types";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";

function profile(id: string, updatedAt: number): WorkbenchComposerProfile {
  return {
    agentPath: null,
    agentSource: null,
    createdAt: 1,
    harness: "codex",
    id,
    model: "gpt-5.4",
    name: `Profile ${id}`,
    reasoningEffort: "high",
    scope: { kind: "global" },
    serviceTier: null,
    updatedAt,
  };
}

test("persists acknowledged profile mutations across store restarts", async (context) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-profile-store-"));
  context.after(async () => await rm(storageRoot, { force: true, recursive: true }));
  const store = new WorkbenchComposerProfileStore(storageRoot);

  await store.mutate({ kind: "upsert", profile: profile("alpha", 2) });
  await store.mutate({ kind: "upsert", profile: profile("beta", 1) });
  await store.mutate({ kind: "upsert", profile: profile("beta", 4) });
  await store.mutate({ kind: "delete", profileId: "alpha" });
  assert.deepEqual((await new WorkbenchComposerProfileStore(storageRoot).read()).profiles, [profile("beta", 4)]);
});

test("rejects malformed profile mutations", async (context) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-profile-store-invalid-"));
  context.after(async () => await rm(storageRoot, { force: true, recursive: true }));
  await assert.rejects(
    new WorkbenchComposerProfileStore(storageRoot).mutate({ kind: "upsert", profile: { id: "broken" } }),
    /valid composer profile mutation/u,
  );
});
