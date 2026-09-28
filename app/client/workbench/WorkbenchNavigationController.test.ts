/* No production exports. Protect route supersession, partial reads and draft-preserving canonicalisation. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createHomeRoute, createLogicalProjectRoute, createLogicalThreadRoute, createObservedProjectRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import { DaemonIdSchema, DraftIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchNavigationController from "./WorkbenchNavigationController";

const projectId = "00000000-0000-4000-8000-000000000001";
const location = { daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002"),
  projectId: ProjectIdSchema.parse("local-folder") };
const draftId = DraftIdSchema.parse("00000000-0000-4000-8000-000000000003");

test("pending facts render progress, then the same route can become ready without an error latch", async () => {
  let available = false;
  const route = createLogicalProjectRoute(projectId);
  const navigation = new WorkbenchNavigationController(route, {
    load: async () => available ? { ok: true } : { ok: false, pending: true },
  });
  await navigation.applyRoute(route);
  assert.equal(navigation.getSnapshot().phase, "loading");
  assert.equal(navigation.getSnapshot().error, null);
  available = true;
  await navigation.applyRoute(route);
  assert.equal(navigation.getSnapshot().phase, "ready");
  navigation.dispose();
});

test("a superseded route is cancelled and its late failure cannot replace a newer view", async () => {
  const pending = Promise.withResolvers<{ ok: false; error: string }>();
  const first = Promise.withResolvers<AbortSignal>();
  const navigation = new WorkbenchNavigationController(createHomeRoute(), {
    load: async (route, context) => {
      if (route.view === "home") { first.resolve(context.signal); return pending.promise; }
      return { ok: true };
    },
  });
  const old = navigation.applyRoute(createHomeRoute());
  const next = createLogicalProjectRoute(projectId);
  await navigation.applyRoute(next);
  assert.ok((await first.promise).aborted);
  pending.resolve({ ok: false, error: "old source unavailable" });
  await old;
  assert.equal(navigation.getSnapshot().route, next);
  assert.equal(navigation.getSnapshot().error, null);
  navigation.dispose();
});

test("source registration and draft materialisation retarget without reloading the composer", async () => {
  const initial = { ...createObservedProjectRoute(location), view: "thread" as const,
    threadTarget: { kind: "new" as const }, threadId: "new" };
  let loads = 0;
  const navigation = new WorkbenchNavigationController(initial, { load: async () => { loads++; return { ok: true }; } });
  await navigation.applyRoute(initial);
  const canonical = createLogicalThreadRoute(projectId, projectId, null, { kind: "draft", draftId });
  assert.equal(navigation.retargetDraftSession(canonical, draftId, location), true);
  assert.equal(navigation.getSnapshot().route, canonical);
  assert.equal(loads, 1);
  navigation.dispose();
});

test("draft canonicalisation cannot transfer the composer to an unrelated folder", async () => {
  const initial = { ...createObservedProjectRoute(location), view: "thread" as const,
    threadTarget: { kind: "new" as const }, threadId: "new" };
  const navigation = new WorkbenchNavigationController(initial, { load: async () => ({ ok: true }) });
  await navigation.applyRoute(initial);
  const other = { ...location, projectId: ProjectIdSchema.parse("other-folder") };
  const canonical = createLogicalThreadRoute(projectId, projectId, other, { kind: "draft", draftId });
  assert.equal(navigation.retargetDraftSession(canonical, draftId), false);
  assert.equal(navigation.getSnapshot().route, initial);
  navigation.dispose();
});
