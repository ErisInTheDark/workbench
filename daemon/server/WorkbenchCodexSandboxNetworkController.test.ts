/*
 * No production exports. Tests protect persisted default-off global and project Codex sandbox network resolution.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { DaemonProcessContext } from "./daemon-process-context";
let WorkbenchDatabaseNode: typeof import("./WorkbenchDatabaseNode").default;
let CodexConfigurationNode: typeof import("./CodexConfigurationNode").default;
let discoveryRoot: string;
const previousProjectsRoot = process.env.WORKBENCH_PROJECTS_ROOT;
const previousLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;

before(async () => {
  discoveryRoot = await mkdtemp(join(tmpdir(), "workbench-network-discovery-"));
  await mkdir(join(discoveryRoot, "project", ".git"), { recursive: true });
  await mkdir(join(discoveryRoot, "other", ".git"), { recursive: true });
  process.env.WORKBENCH_PROJECTS_ROOT = discoveryRoot;
  process.env.WORKBENCH_LIBRARY_ROOT = join(discoveryRoot, "library");
  ({ default: WorkbenchDatabaseNode } = await import("./WorkbenchDatabaseNode"));
  ({ default: CodexConfigurationNode } = await import("./CodexConfigurationNode"));
});

after(async () => {
  if (previousProjectsRoot === undefined) delete process.env.WORKBENCH_PROJECTS_ROOT;
  else process.env.WORKBENCH_PROJECTS_ROOT = previousProjectsRoot;
  if (previousLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
  else process.env.WORKBENCH_LIBRARY_ROOT = previousLibraryRoot;
  if (discoveryRoot) await rm(discoveryRoot, { recursive: true, force: true });
});

function createDatabaseNode(directory: string) {
  return WorkbenchDatabaseNode.create(
    { dataRootPath: join(directory, "data"), legacyMigrationProjectRoot: directory } as DaemonProcessContext,
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

function createConfigurationNode(database: NonNullable<ReturnType<typeof createDatabaseNode>["registrations"]["database"]>) {
  return CodexConfigurationNode.create({} as DaemonProcessContext, {
    get: key => {
      if (key !== "database") throw new Error(`Unexpected configuration dependency ${key}.`);
      return database as never;
    },
    run: () => { throw new Error("Unexpected graph operation in configuration fixture"); },
    getSourceState: () => { throw new Error("Unexpected source access in configuration fixture"); },
    handoffState: undefined,
    isReplacing: () => false,
    lease: { isCurrent: () => true },
    mode: "initial",
  });
}

test("Codex sandbox network settings persist global and project inheritance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-codex-network-"));
  let databaseNode = createDatabaseNode(directory);
  let configurationNode = createConfigurationNode(databaseNode.registrations.database!);
  try {
    await databaseNode.start();
    const projects = databaseNode.registrations.database!.readInitialProjectCatalog().catalog;
    const projectId = projects.find(record => record.project.name === "project")?.project.id;
    const otherId = projects.find(record => record.project.name === "other")?.project.id;
    assert.ok(projectId && otherId);
    let settings = configurationNode.registrations.codexSandboxNetwork!;
    assert.deepEqual(await settings.read(projectId), {
      effectiveEnabled: false,
      globalEnabled: false,
      projectId,
      projectOverride: null,
    });

    await settings.setGlobal(true);
    assert.equal((await settings.read(projectId)).effectiveEnabled, true);

    await settings.setProjectOverride(projectId, false);
    assert.deepEqual(await settings.read(projectId), {
      effectiveEnabled: false,
      globalEnabled: true,
      projectId,
      projectOverride: false,
    });

    await settings.setProjectOverride(otherId, true);
    await configurationNode.dispose();
    await databaseNode.dispose();
    databaseNode = createDatabaseNode(directory);
    await databaseNode.start();
    configurationNode = createConfigurationNode(databaseNode.registrations.database!);
    settings = configurationNode.registrations.codexSandboxNetwork!;
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
    await configurationNode.dispose();
    await databaseNode.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
