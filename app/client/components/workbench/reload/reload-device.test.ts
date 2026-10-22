/* Exports: none; protects which updates and reloads warn before restarting a process. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchReloadDirtScope } from "workbench-shared/types";
import type { PredictedInstallationUpdate as InstallationUpdate } from "workbench-shared/workbench/installation-update-prediction";
import { DANGER_HOLD_MS, UPDATE_HOLD_MS, mergeReloadDirt, planReloadDevice } from "./reload-device";

const scope = (name: string, extra: Partial<WorkbenchReloadDirtScope> = {}): WorkbenchReloadDirtScope => ({
  scope: name, description: name, destructive: false, dependantScopes: [], ...extra,
});
const dirt = (...scopes: WorkbenchReloadDirtScope[]) => ({ dirtyScopes: scopes, error: null, pendingScopes: [] });
const update = (overrides: Partial<InstallationUpdate> = {}): InstallationUpdate => ({
  state: "available", reason: null, upstream: "origin/main", behind: 4, ahead: 0, conflicts: [], lockfileChanged: false,
  incomingPaths: [], predictedScopes: [], checkedAt: 1, projectId: null, failure: null, ...overrides,
});

test("an update that dirties only reloadable scopes does not warn, even with nothing dirty yet", () => {
  const plan = planReloadDevice({ local: true, dirt: dirt(), appUpdateScopes: [scope("client:http")],
    update: update({ predictedScopes: [scope("server:git")] }) });
  assert.deepEqual(plan.update, { count: 4, impact: { restarts: [], migrates: false }, danger: false,
    holdMs: UPDATE_HOLD_MS, blocked: null });
});

test("an update warns when its own dirt, the app's prediction or existing dirt restarts something", () => {
  const restarting = scope("server:codex", { destructive: true });
  for (const facts of [
    { dirt: dirt(), appUpdateScopes: [], update: update({ predictedScopes: [restarting] }) },
    { dirt: dirt(), appUpdateScopes: [scope("client:process", { destructive: true })], update: update() },
    { dirt: dirt(restarting), appUpdateScopes: [], update: update() },
  ]) {
    const plan = planReloadDevice({ local: true, ...facts });
    assert.equal(plan.update?.danger, true);
    assert.equal(plan.update?.holdMs, DANGER_HOLD_MS);
  }
  const install = planReloadDevice({ local: true, dirt: dirt(), appUpdateScopes: [], update: update({ lockfileChanged: true }) });
  assert.deepEqual(install.update?.impact?.restarts, ["app"]);
});

test("an update whose dirt is unknown warns rather than guessing it is safe", () => {
  for (const facts of [
    { appUpdateScopes: [], update: update({ predictedScopes: null }) },
    { appUpdateScopes: null, update: update() },
  ]) {
    const plan = planReloadDevice({ local: true, dirt: dirt(), ...facts });
    assert.equal(plan.update?.impact, null);
    assert.equal(plan.update?.danger, true);
  }
});

test("another device's update needs no app prediction but cannot install from here", () => {
  const plain = planReloadDevice({ local: false, dirt: null, update: update({ predictedScopes: [scope("server:git")] }) });
  assert.equal(plain.update?.danger, false);
  const install = planReloadDevice({ local: false, dirt: null, update: update({ lockfileChanged: true }) });
  assert.match(install.update?.blocked ?? "", /that device/u);
});

test("this device's app and daemon dirt merge into one device", () => {
  const merged = mergeReloadDirt(
    { dirtyScopes: [scope("client:http")], error: null, pendingScopes: [] },
    { dirtyScopes: [scope("server:core")], error: "daemon warning", pendingScopes: ["server:core"] },
  );
  assert.deepEqual(merged?.dirtyScopes.map(item => item.scope), ["client:http", "server:core"]);
  assert.equal(merged?.error, "daemon warning");
  assert.deepEqual(merged?.pendingScopes, ["server:core"]);
});

test("migrations surface on reloads and on updates that bring them", () => {
  const migrating = scope("server:database", { migration: { label: "database", from: 30, to: 31 } });
  assert.equal(planReloadDevice({ local: false, dirt: dirt(migrating), update: null }).reload?.migrates, true);
  assert.equal(planReloadDevice({ local: false, dirt: null, update: update({ predictedScopes: [migrating] }) }).update?.impact?.migrates, true);
});
