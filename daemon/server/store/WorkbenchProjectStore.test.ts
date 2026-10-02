/* No production exports. Tests encrypted store reads, writes and identity changes through real SQLite rows. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import WorkbenchProjectStoreRepository from "../database/store/WorkbenchProjectStoreRepository";
import { installWorkbenchDatabaseSchema } from "../database/workbench-database-schema";
import type { ResolvedProject } from "../lib/project";
import WorkbenchProjectStore from "./WorkbenchProjectStore";

function fixture(context: TestContext) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(() => database.close());
  database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(testProjectIds.project);
  const repository = new WorkbenchProjectStoreRepository(database);
  const project = { id: testProjectIds.project, kind: "git", root: "/synthetic/project", rootPath: "/synthetic/project", roots: [] } as ResolvedProject;
  const identity = { device: "device-a", read: async () => identity.device };
  const create = () => new WorkbenchProjectStore({
    execute: async command => repository.execute(command),
    readDeviceIdentity: () => identity.read(),
    resolveProjectById: async () => project,
    resolveProjectFromCwd: async () => ({ project }),
    user: () => "synthetic-user",
  });
  return { database, project, identity, create };
}

test("settings and CLI paths share encrypted values without storing plaintext", async context => {
  const { database, create } = fixture(context);
  const store = create();
  await store.update({ projectId: testProjectIds.project, upserts: [{ key: "TOKEN", value: "s3cret\nline" }, { key: "GONE", value: "x" }], removals: [] });
  await store.update({ projectId: testProjectIds.project, upserts: [], removals: ["GONE"] });
  await store.setFromCwd("/synthetic/project/sub", "OTHER", "two");
  assert.deepEqual(await store.read(testProjectIds.project), { entries: [{ key: "OTHER", value: "two" }, { key: "TOKEN", value: "s3cret\nline" }] });
  assert.equal(await store.getFromCwd("/synthetic/project", "TOKEN"), "s3cret\nline");
  assert.equal(await store.getFromCwd("/synthetic/project", "MISSING"), null);
  const stored = database.prepare("SELECT ciphertext FROM workbench_project_store_entries").all() as { ciphertext: Buffer }[];
  assert.ok(stored.every(row => !row.ciphertext.toString("utf8").includes("s3cret")));
});

test("values become unreadable rather than failing reads when the device changes", async context => {
  const { identity, create } = fixture(context);
  await create().update({ projectId: testProjectIds.project, upserts: [{ key: "TOKEN", value: "v" }], removals: [] });
  identity.device = "device-b";
  const moved = create();
  assert.deepEqual(await moved.read(testProjectIds.project), { entries: [{ key: "TOKEN", unreadable: true }] });
  await assert.rejects(moved.getFromCwd("/synthetic/project", "TOKEN"), /cannot be decrypted/);
});

test("an unreadable device identity fails clearly and is retried later", async context => {
  const { identity, create } = fixture(context);
  let attempts = 0;
  identity.read = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("no machine id");
    return "device-a";
  };
  const store = create();
  await assert.rejects(store.read(testProjectIds.project), /no machine id/);
  assert.deepEqual(await store.read(testProjectIds.project), { entries: [] });
});
