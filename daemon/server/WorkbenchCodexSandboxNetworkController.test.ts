/*
 * No production exports. Tests protect persisted default-off global and project Codex sandbox network resolution.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DaemonProcessContext } from "./daemon-process-context";
import WorkbenchDatabaseNode from "./WorkbenchDatabaseNode";

function createDatabaseNode(directory: string) {
  return WorkbenchDatabaseNode.create(
    { legacyMigrationProjectRoot: directory } as DaemonProcessContext,
    {
      get: () => {
        throw new Error("The database root has no registration requirements");
      },
      run: () => { throw new Error("Unexpected graph operation in node fixture"); },
      getSourceState: () => { throw new Error("Unexpected source access in node fixture"); },
      handoffState: undefined,
      isReplacing: () => false,
      lease: { isCurrent: () => true },
      mode: "initial",
    },
  );
}

test("Codex sandbox network settings persist global and project inheritance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-codex-network-"));
  let databaseNode = createDatabaseNode(directory);
  try {
    await databaseNode.start();
    let settings = databaseNode.registrations.codexSandboxNetwork!;
    assert.deepEqual(await settings.read("project"), {
      effectiveEnabled: false,
      globalEnabled: false,
      projectId: "project",
      projectOverride: null,
    });

    await settings.setGlobal(true);
    assert.equal((await settings.read("project")).effectiveEnabled, true);

    await settings.setProjectOverride("project", false);
    assert.deepEqual(await settings.read("project"), {
      effectiveEnabled: false,
      globalEnabled: true,
      projectId: "project",
      projectOverride: false,
    });

    await settings.setProjectOverride("other", true);
    await databaseNode.dispose();
    databaseNode = createDatabaseNode(directory);
    await databaseNode.start();
    settings = databaseNode.registrations.codexSandboxNetwork!;
    assert.equal((await settings.read("project")).projectOverride, false);
    assert.equal((await settings.read("other")).effectiveEnabled, true);

    await settings.setProjectOverride("project", null);
    assert.deepEqual(await settings.read("project"), {
      effectiveEnabled: true,
      globalEnabled: true,
      projectId: "project",
      projectOverride: null,
    });

    await settings.setGlobal(false);
    assert.equal(await settings.resolve("project"), false);
    assert.equal(await settings.resolve("other"), true);
  } finally {
    await databaseNode.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
