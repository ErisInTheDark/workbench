/*
 * No production exports. Exercise real SQLite permission rows and failure propagation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";
import { renderCreateTable } from "workbench-shared/database/schema/schema-definition";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchCommandApprovalController, { type CommandApprovalDatabase } from "./WorkbenchCommandApprovalController.ts";
import { commandApprovalRules, commandApprovalTokens } from "./lib/workbench/database/schema/command-approval-schema.ts";

test("saved permissions survive owner replacement and isolate project, directory and token prefix", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE workbench_projects (id TEXT PRIMARY KEY)");
  const project = ProjectIdSchema.parse("a6652caf-f7c1-4a2a-ab55-6b387a19ab05");
  const other = ProjectIdSchema.parse("4b0a6d4c-78d6-4919-ac2b-a270453714ac");
  database.prepare("INSERT INTO workbench_projects VALUES (?)").run(project);
  database.prepare("INSERT INTO workbench_projects VALUES (?)").run(other);
  const tables = { [commandApprovalRules.name]: commandApprovalRules, [commandApprovalTokens.name]: commandApprovalTokens };
  for (const table of Object.values(tables)) database.exec(renderCreateTable(table));
  const port: CommandApprovalDatabase = {
    query: async <Row extends WorkbenchDatabaseRow>(query: Parameters<CommandApprovalDatabase["query"]>[0]) => {
      const compiled = compileWorkbenchDatabaseStatement(tables, query);
      return database.prepare(compiled.sql).all(...compiled.parameters) as Row[];
    },
    executeTransaction: async statements => database.transaction(() => {
      let changes = 0;
      for (const statement of statements) {
        const compiled = compileWorkbenchDatabaseStatement(tables, statement);
        changes += database.prepare(compiled.sql).run(...compiled.parameters).changes;
      }
      return { changes };
    })(),
  };
  try {
    let owner = new WorkbenchCommandApprovalController(port);
    const saved = await owner.save(project, "C:\\Repo\\", ["pnpm", "test"]);
    owner = new WorkbenchCommandApprovalController(port);
    assert.equal((await owner.list(project)).length, 1);
    assert.equal((await owner.match(project, "c:/repo", ["pnpm", "test", "--watch"]))?.id, saved.id);
    assert.equal(await owner.match(other, "C:/repo", ["pnpm", "test"]), null);
    assert.equal(await owner.match(project, "C:/repo/sub", ["pnpm", "test"]), null);
    assert.equal(await owner.match(project, "C:/repo", ["pnpm", "testing"]), null);
    await owner.remove(other, saved.id);
    assert.equal((await owner.list(project)).length, 1);
    await owner.remove(project, saved.id);
    assert.equal(await owner.match(project, "C:/repo", ["pnpm", "test"]), null);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM command_approval_tokens").get() as { count: number }).count, 0);
    await assert.rejects(owner.save(project, "relative", ["pnpm", "test"]));
    await assert.rejects(owner.save(project, "C:/repo", []));
  } finally { database.close(); }
});

test("persistence failures propagate rather than granting a permission", async () => {
  const owner = new WorkbenchCommandApprovalController({
    query: async () => { throw new Error("read unavailable"); },
    executeTransaction: async () => { throw new Error("write unavailable"); },
  });
  const project = ProjectIdSchema.parse("a6652caf-f7c1-4a2a-ab55-6b387a19ab05");
  await assert.rejects(owner.match(project, "C:/repo", ["pnpm", "test"]), /read unavailable/);
  await assert.rejects(owner.save(project, "C:/repo", ["pnpm", "test"]), /write unavailable/);
  await assert.rejects(owner.remove(project, "id"), /write unavailable/);
});
