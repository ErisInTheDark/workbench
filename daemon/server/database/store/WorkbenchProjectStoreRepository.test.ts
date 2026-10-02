/* No production exports. Tests project isolation and all-or-nothing store edits. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchProjectStoreRepository from "./WorkbenchProjectStoreRepository";

function fixture(context: TestContext) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(() => database.close());
  for (const id of [testProjectIds.project, testProjectIds.other]) {
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(id);
  }
  return new WorkbenchProjectStoreRepository(database);
}

const entry = (key: string, byte: number) => ({ key, nonce: Uint8Array.of(byte), ciphertext: Uint8Array.of(byte, byte) });
const keys = (result: ReturnType<WorkbenchProjectStoreRepository["execute"]>) =>
  result.kind === "entries" ? result.entries.map(item => `${item.key}:${Buffer.from(item.ciphertext).toString("hex")}`) : [];

test("edits apply per project and leave unrelated keys alone", context => {
  const store = fixture(context);
  const project = testProjectIds.project;
  store.execute({ kind: "apply", projectId: project, upserts: [entry("A", 1), entry("B", 2)], removals: [], now: 1 });
  store.execute({ kind: "apply", projectId: testProjectIds.other, upserts: [entry("A", 9)], removals: [], now: 1 });
  store.execute({ kind: "apply", projectId: project, upserts: [entry("C", 3)], removals: ["A"], now: 2 });
  assert.deepEqual(keys(store.execute({ kind: "list", projectId: project })), ["B:0202", "C:0303"]);
  assert.deepEqual(keys(store.execute({ kind: "list", projectId: testProjectIds.other })), ["A:0909"]);
  const got = store.execute({ kind: "get", projectId: project, key: "C" });
  assert.equal(got.kind === "entry" && got.entry?.key, "C");
});

test("a failing edit rolls back its removals", context => {
  const store = fixture(context);
  const project = testProjectIds.project;
  store.execute({ kind: "apply", projectId: project, upserts: [entry("A", 1)], removals: [], now: 1 });
  assert.throws(() => store.execute({
    kind: "apply", projectId: project, removals: ["A"], now: 2,
    upserts: [{ key: "B", nonce: Uint8Array.of(1), ciphertext: null as unknown as Uint8Array }],
  }));
  assert.deepEqual(keys(store.execute({ kind: "list", projectId: project })), ["A:0101"]);
});
