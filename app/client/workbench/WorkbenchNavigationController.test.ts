/* No production exports. Protect route supersession and partial reads. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createHomeRoute, createLogicalProjectRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchNavigationController from "./WorkbenchNavigationController";

const projectId = "00000000-0000-4000-8000-000000000001";

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
