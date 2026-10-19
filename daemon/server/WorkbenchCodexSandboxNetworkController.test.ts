/*
 * No production exports. Tests protect persisted default-off global and project Codex sandbox network resolution.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { renderCreateTable } from "workbench-shared/database/schema/schema-definition";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";

import WorkbenchCodexSandboxNetworkController, { type WorkbenchCodexSandboxNetworkDatabase } from "./WorkbenchCodexSandboxNetworkController";
import { codexSandboxNetworkTables } from "./lib/workbench/database/schema/codex-sandbox-network-schema";

const tables = Object.fromEntries(Object.values(codexSandboxNetworkTables).map(table => [table.name, table]));

function networkDatabase(database: Database.Database): WorkbenchCodexSandboxNetworkDatabase {
  for (const table of Object.values(tables)) database.exec(renderCreateTable(table));
  return {
    query: async <Row extends WorkbenchDatabaseRow>(query: Parameters<WorkbenchCodexSandboxNetworkDatabase["query"]>[0]) => {
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
}

test("Codex sandbox network settings persist global and project inheritance", async () => {
  const database = new Database(":memory:");
  const port = networkDatabase(database);
  const projectId = "project";
  const otherId = "other";
  try {
    let settings = new WorkbenchCodexSandboxNetworkController(port);
    assert.deepEqual(await settings.read(projectId), {
      effectiveEnabled: false,
      globalEnabled: false,
      projectId,
      projectOverride: null,
    });
    assert.deepEqual(await settings.read(null), {
      effectiveEnabled: false,
      globalEnabled: false,
      projectId: null,
      projectOverride: null,
    });

    await settings.setGlobal(true);
    assert.equal((await settings.read(projectId)).effectiveEnabled, true);

    await settings.setProjectOverride(projectId, false);
    assert.deepEqual(await settings.read(null), {
      effectiveEnabled: true,
      globalEnabled: true,
      projectId: null,
      projectOverride: null,
    });
    assert.deepEqual(await settings.read(projectId), {
      effectiveEnabled: false,
      globalEnabled: true,
      projectId,
      projectOverride: false,
    });

    await settings.setProjectOverride(otherId, true);
    await settings.waitForIdle();
    settings = new WorkbenchCodexSandboxNetworkController(port);
    assert.equal((await settings.read(projectId)).projectOverride, false);
    assert.equal((await settings.read(otherId)).effectiveEnabled, true);

    await settings.setProjectOverride(projectId, null);
    assert.deepEqual(await settings.read(projectId), {
      effectiveEnabled: true,
      globalEnabled: true,
      projectId,
      projectOverride: null,
    });

    await settings.setGlobal(false);
    assert.equal(await settings.resolve(projectId), false);
    assert.equal(await settings.resolve(otherId), true);
  } finally {
    database.close();
  }
});
