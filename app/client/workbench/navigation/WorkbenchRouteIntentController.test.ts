/* No production exports. Protect latest route intent, source recovery and canonical results. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHomeRoute, createLogicalProjectRoute } from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchRouteIntentController from "./WorkbenchRouteIntentController";

async function flush() {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

test("a late source retries the retained intent and emits its canonical route", async () => {
  const route = createLogicalProjectRoute("00000000-0000-4000-8000-000000000001");
  const canonical = createLogicalProjectRoute("00000000-0000-4000-8000-000000000002");
  const attempts: string[] = [];
  const published: string[] = [];
  const controller = new WorkbenchRouteIntentController({
    apply: async requested => {
      attempts.push(requested.logical?.projectId ?? "");
      return attempts.length === 1
        ? { ok: false, error: "source unavailable" }
        : { ok: true, canonicalRoute: canonical };
    },
  });
  controller.subscribeCanonical(next => published.push(next.logical?.projectId ?? ""));
  controller.request(route);
  await Promise.resolve();
  assert.deepEqual(attempts, [route.logical!.projectId]);
  controller.factsChanged();
  await Promise.resolve();
  assert.deepEqual(attempts, [route.logical!.projectId, route.logical!.projectId]);
  assert.deepEqual(published, [canonical.logical!.projectId]);
  controller.factsChanged();
  await flush();
  assert.equal(attempts.length, 2, "source changes must not reopen an already admitted route");
  controller.dispose();
});

test("source arrival during a failed attempt retries once", async () => {
  const first = Promise.withResolvers<{ ok: false; error: string }>();
  const route = createLogicalProjectRoute("00000000-0000-4000-8000-000000000001");
  const attempts: string[] = [];
  const controller = new WorkbenchRouteIntentController({
    apply: async requested => {
      attempts.push(requested.logical?.projectId ?? "");
      return attempts.length === 1 ? await first.promise : { ok: true };
    },
  });
  controller.request(route);
  controller.factsChanged();
  first.resolve({ ok: false, error: "source unavailable" });
  await flush();
  assert.deepEqual(attempts, [route.logical!.projectId, route.logical!.projectId]);
  controller.dispose();
});

test("a newer route wins when the previous source read completes late", async () => {
  const old = Promise.withResolvers<{ ok: true; canonicalRoute: ReturnType<typeof createLogicalProjectRoute> }>();
  const firstRoute = createLogicalProjectRoute("00000000-0000-4000-8000-000000000001");
  const second = createLogicalProjectRoute("00000000-0000-4000-8000-000000000002");
  const published: string[] = [];
  const attempts: string[] = [];
  const controller = new WorkbenchRouteIntentController({
    apply: async route => {
      attempts.push(route.logical?.projectId ?? "");
      return attempts.length === 1 ? await old.promise : { ok: true, canonicalRoute: second };
    },
  });
  controller.subscribeCanonical(route => published.push(route.logical?.projectId ?? ""));
  controller.request(firstRoute);
  controller.request(second);
  await flush();
  old.resolve({ ok: true, canonicalRoute: firstRoute });
  await flush();
  assert.deepEqual(attempts, [firstRoute.logical!.projectId, second.logical!.projectId]);
  assert.deepEqual(published, [second.logical!.projectId]);
  controller.request(createHomeRoute());
  controller.dispose();
});

test("direct navigation retires an older failed URL intent", async () => {
  const first = createLogicalProjectRoute("00000000-0000-4000-8000-000000000001");
  const other = createLogicalProjectRoute("00000000-0000-4000-8000-000000000002");
  let attempts = 0;
  const controller = new WorkbenchRouteIntentController({
    apply: async () => { attempts++; return { ok: false, error: "unavailable" }; },
  });
  controller.request(first);
  await flush();
  controller.supersede(other);
  controller.factsChanged();
  await flush();
  assert.equal(attempts, 1);
  controller.dispose();
});
