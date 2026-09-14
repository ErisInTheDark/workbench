/*
 * No exports. Tests protect coalesced resolution and connection-scoped cache lifetime.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ThreadIdentityController from "./ThreadIdentityController";
import type { WorkbenchThreadIdentityResolution } from "workbench-shared/workbench/thread/workbench-thread-identity";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
};

test("alias resolution coalesces reads, reuses canonical identity and cannot repopulate a reset connection", async () => {
  const pending: Array<(value: WorkbenchThreadIdentityResolution | null) => void> = [];
  const controller = new ThreadIdentityController(() => new Promise((resolve) => pending.push(resolve)));
  const alias = { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("provider-thread") };
  const canonical = { ...alias, harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("68054624-3939-4c53-8b92-ac72e6c8024a") };
  const first = controller.resolve(alias);
  const same = controller.resolve(alias);
  assert.equal(pending.length, 1);
  controller.reset();
  const next = controller.resolve(alias);
  assert.equal(pending.length, 2);
  pending[0]!(canonical);
  assert.deepEqual(await first, canonical);
  assert.deepEqual(await same, canonical);
  pending[1]!({ ...canonical, harness: "opencode" });
  assert.equal((await next)?.harness, "opencode");
  assert.equal((await controller.resolve({ threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse(canonical.threadId), projectId: fixtureIdentityValues.ProjectId["project"] }))?.harness, "opencode");
  assert.equal(pending.length, 2);
  controller.dispose();
  await assert.rejects(controller.resolve(alias), /disposed/u);
});

test("unobserved identity is not permanently cached", async () => {
  let reads = 0;
  const controller = new ThreadIdentityController(async () => {
    reads += 1;
    return reads === 1 ? null : { threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("68054624-3939-4c53-8b92-ac72e6c8024a"), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), harness: "codex" };
  });
  const request = { threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("legacy") };
  assert.equal(await controller.resolve(request), null);
  assert.ok(await controller.resolve(request));
  controller.dispose();
});
