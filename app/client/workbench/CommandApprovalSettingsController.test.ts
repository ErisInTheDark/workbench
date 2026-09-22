/*
 * No production exports. Protect authoritative removal and async presentation fencing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { CommandApprovalSnapshot } from "workbench-shared/workbench/settings/command-approvals";
import CommandApprovalSettingsController from "./CommandApprovalSettingsController.ts";

const rule = { id: "6ec53578-a9ef-44df-8f4b-bb62f2d8ae4a", projectId: ProjectIdSchema.parse("a6652caf-f7c1-4a2a-ab55-6b387a19ab05"), workdir: "C:/repo", prefix: ["pnpm", "test"] };

test("failed removal retains rules and exposes failure; successful removal installs the server snapshot", async () => {
  let fail = true;
  const owner = new CommandApprovalSettingsController({
    read: async () => ({ rules: [rule] }),
    remove: async () => { if (fail) throw new Error("permission denied"); return { rules: [] }; },
  });
  await owner.refresh();
  assert.deepEqual(owner.getSnapshot().rules, [rule]);
  await owner.remove(rule.id);
  assert.deepEqual(owner.getSnapshot().rules, [rule]);
  assert.ok(owner.getSnapshot().error);
  assert.equal(owner.getSnapshot().loading, false);
  fail = false;
  await owner.remove(rule.id);
  assert.deepEqual(owner.getSnapshot().rules, []);
  assert.equal(owner.getSnapshot().error, "");
  owner.dispose();
});

test("superseded reads and disposed completions cannot publish stale permissions", async () => {
  const first = Promise.withResolvers<CommandApprovalSnapshot>();
  const second = Promise.withResolvers<CommandApprovalSnapshot>();
  let count = 0;
  const owner = new CommandApprovalSettingsController({
    read: () => ++count === 1 ? first.promise : second.promise,
    remove: async () => ({ rules: [] }),
  });
  const old = owner.refresh();
  const current = owner.refresh();
  second.resolve({ rules: [rule] });
  await current;
  first.resolve({ rules: [] });
  await old;
  assert.deepEqual(owner.getSnapshot().rules, [rule]);
  const pending = Promise.withResolvers<CommandApprovalSnapshot>();
  const disposed = new CommandApprovalSettingsController({ read: () => pending.promise, remove: async () => ({ rules: [] }) });
  let notifications = 0;
  disposed.subscribe(() => { notifications += 1; });
  const load = disposed.refresh();
  disposed.dispose();
  const before = notifications;
  pending.resolve({ rules: [rule] });
  await load;
  assert.equal(notifications, before);
  assert.deepEqual(disposed.getSnapshot().rules, []);
  owner.dispose();
});
