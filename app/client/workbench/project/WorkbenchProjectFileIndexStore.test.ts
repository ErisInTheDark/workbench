/*
 * No production exports. Protect qualified reads, retry, and disposal fences.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchProjectFileIndexStore from "./WorkbenchProjectFileIndexStore";

const first = {
  daemonId: DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c"),
  projectId: ProjectIdSchema.parse("first"),
};
const second = {
  daemonId: DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029"),
  projectId: ProjectIdSchema.parse("second"),
};

test("simultaneous readers share one project-qualified read without mixing folders", async () => {
  const requests: string[] = [];
  const release = Promise.withResolvers<void>();
  const store = new WorkbenchProjectFileIndexStore(async target => {
    requests.push(target.projectId);
    if (target.projectId === first.projectId) await release.promise;
    return {
      projectId: target.projectId, key: target.projectId,
      candidates: [{ path: `${target.projectId}.ts`, isIgnored: false }],
    };
  });
  const firstRead = store.ensure(first);
  const duplicate = store.ensure(first);
  const other = await store.ensure(second);
  release.resolve();
  await Promise.all([firstRead, duplicate]);
  assert.deepEqual(requests, ["first", "second"]);
  assert.deepEqual(store.getSnapshot(first).paths, ["first.ts"]);
  assert.deepEqual(other.paths, ["second.ts"]);
  store.dispose();
});

test("failed reads retain the last index and retry can replace it", async (context) => {
  const previousError = console.error;
  console.error = () => undefined;
  context.after(() => { console.error = previousError; });
  let fail = false;
  let revision = 0;
  const store = new WorkbenchProjectFileIndexStore(async target => {
    if (fail) throw new Error("read failed");
    revision += 1;
    return { projectId: target.projectId, key: String(revision),
      candidates: [{ path: `version-${revision}.ts`, isIgnored: false }] };
  });
  await store.ensure(first);
  fail = true;
  assert.equal((await store.ensure(first, true)).status, "error");
  assert.deepEqual(store.getSnapshot(first).paths, ["version-1.ts"]);
  fail = false;
  assert.equal((await store.ensure(first, true)).status, "ready");
  assert.deepEqual(store.getSnapshot(first).paths, ["version-2.ts"]);
  store.dispose();
});

test("a disposed store cannot publish a late read", async () => {
  const release = Promise.withResolvers<void>();
  const store = new WorkbenchProjectFileIndexStore(async target => {
    await release.promise;
    return { projectId: target.projectId, key: "late", candidates: [{ path: "late.ts", isIgnored: false }] };
  });
  let publications = 0;
  store.subscribe(first, () => { publications += 1; });
  const pending = store.ensure(first);
  assert.equal(publications, 1);
  store.dispose();
  release.resolve();
  await pending;
  assert.equal(publications, 1);
});
