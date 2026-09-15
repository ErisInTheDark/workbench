/*
 * No exports. Tests protect browser database cloning, isolation, seed refresh, failure cleanup and disposal.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { captureTestOutput } from "../../../test/capture-test-output.mts";
import Database from "better-sqlite3";

import { applyWorkbenchDatabaseSchema } from "workbench-shared/database/schema/schema-history";
import { appStateSchema } from "workbench-shared/state/workbench-app-state-schema";
import { projectWorkbenchClientStateRows } from "workbench-shared/state/workbench-client-state-projection";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";

import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import WorkbenchBrowserStateRegistry from "./WorkbenchBrowserStateRegistry.ts";

const BROWSER_A = "10000000-0000-4000-8000-000000000001";
const BROWSER_B = "20000000-0000-4000-8000-000000000002";
const BROWSER_C = "30000000-0000-4000-8000-000000000003";
const BROWSER_D = "40000000-0000-4000-8000-000000000004";

test("project aliases reach open stores and dormant stores before their next read", async context => {
  const { directory, registry, shared } = await fixture(context);
  const projectId = ProjectIdSchema.parse("remote://example.test/owner/repo");
  for (const browser of [BROWSER_A, BROWSER_B]) {
    const owner = await registry.readBrowser(browser);
    await registry.mutateBrowser(browser, { action: "put", record: {
      kind: "composerDraft", daemonRegistrationId: owner.daemonRegistrationId, projectId: "old", threadId: browser,
      value: { text: browser, updatedAt: 1, attachments: [] },
    } });
  }
  await registry.close();
  const reopened = new WorkbenchBrowserStateRegistry(shared, { browserStateDirectoryPath: path.join(directory, "browser-state") });
  reopened.start();
  try {
    const owner = await reopened.readBrowser(BROWSER_A);
    await reopened.remapBrowserProjects(BROWSER_A, {
      daemonRegistrationId: owner.daemonRegistrationId, aliases: [{ alias: "old", projectId }],
    });
    for (const browser of [BROWSER_A, BROWSER_B]) {
      const drafts = records(await reopened.readBrowser(browser)).filter(record => record.kind === "composerDraft");
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0]!.projectId, projectId);
      assert.equal(drafts[0]!.value.text, browser);
    }
  } finally { await reopened.close(); }
});

test("model favourites remain browser-local, provider-specific and durable", async (context) => {
  const { directory, registry, shared } = await fixture(context);
  await registry.readBrowser(BROWSER_A);
  await registry.readBrowser(BROWSER_B);
  const preference = { kind: "modelPreference" as const, harness: "codex" as const, modelId: "same-model", favourite: false };
  await registry.mutateBrowser(BROWSER_A, { action: "put", record: preference });
  await registry.mutateBrowser(BROWSER_A, { action: "put", record: { ...preference, harness: "copilot", favourite: true } });
  const readModels = async (owner: WorkbenchBrowserStateRegistry, browser: string) =>
    records(await owner.readBrowser(browser)).filter(record => record.kind === "modelPreference");
  assert.deepEqual(await readModels(registry, BROWSER_B), []);
  assert.deepEqual(await readModels(registry, BROWSER_A), [preference, { ...preference, harness: "copilot", favourite: true }]);
  await registry.close();
  const reopened = new WorkbenchBrowserStateRegistry(shared, { browserStateDirectoryPath: path.join(directory, "browser-state") });
  reopened.start();
  try {
    assert.deepEqual(await readModels(reopened, BROWSER_A), [preference, { ...preference, harness: "copilot", favourite: true }]);
    await reopened.mutateBrowser(BROWSER_A, { action: "put", record: { ...preference, favourite: true } });
    assert.equal((await readModels(reopened, BROWSER_A))[0]?.favourite, true);
    await reopened.mutateBrowser(BROWSER_A, { action: "delete", identity: { kind: "modelPreference", harness: "codex", modelId: "same-model" } });
    assert.deepEqual(await readModels(reopened, BROWSER_A), [{ ...preference, harness: "copilot", favourite: true }]);
  } finally {
    await reopened.close();
  }
});

function records(response: Awaited<ReturnType<WorkbenchBrowserStateRegistry["readBrowser"]>>) {
  return projectWorkbenchClientStateRows(response.rows).flatMap((change) => (
    change.change === "upsert" ? [change.record] : []
  ));
}

function globalPreference(
  values: readonly WorkbenchClientStateRecord[],
  key: Extract<WorkbenchClientStateRecord, { kind: "globalPreference" }>["preference"]["key"],
): Extract<WorkbenchClientStateRecord, { kind: "globalPreference" }> | undefined {
  return values.find((record): record is Extract<WorkbenchClientStateRecord, { kind: "globalPreference" }> => (
    record.kind === "globalPreference" && record.preference.key === key
  ));
}

async function fixture(context: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-browser-state-"));
  const shared = new WorkbenchAppStateRepository({
    databasePath: path.join(directory, "app-state.sqlite3"),
  });
  await shared.start();
  const diagnostics: string[] = [];
  const registry = new WorkbenchBrowserStateRegistry(shared, {
    browserStateDirectoryPath: path.join(directory, "browser-state"),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  registry.start();
  context.after(async () => {
    await registry.close();
    await shared.close();
    await fs.rm(directory, { force: true, recursive: true });
  });
  return { diagnostics, directory, registry, shared };
}

test("opening an existing browser database backs it up before upgrading", async (context) => {
  const { directory, registry } = await fixture(context);
  captureTestOutput(context, process.stdout, text => text.startsWith("[database] preserved schema ") && text.includes(directory));
  const browserDirectory = path.join(directory, "browser-state");
  await fs.mkdir(browserDirectory);
  const databasePath = path.join(browserDirectory, `${BROWSER_A}.sqlite3`);
  const old = new Database(databasePath);
  applyWorkbenchDatabaseSchema(old, appStateSchema, { targetVersion: 1 });
  old.prepare("INSERT INTO global_preferences(key,text_value,deleted,revision) VALUES ('theme','retained',0,1)").run();
  old.close();
  assert.equal(globalPreference(records(await registry.readBrowser(BROWSER_A)), "theme")?.preference.value, "retained");
  const backups = path.join(browserDirectory, "backups", path.basename(databasePath));
  const files = await fs.readdir(backups).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.equal(files.length, 1, "lazy browser opening must preserve its pre-upgrade database");
  const backup = new Database(path.join(backups, files[0]!), { readonly: true, fileMustExist: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(backup.prepare("SELECT text_value FROM global_preferences WHERE key='theme'").get(), { text_value: "retained" });
  } finally {
    backup.close();
  }
});

test("UUID databases clone, diverge, reopen, and share one coalesced first open", async (context) => {
  const { directory, registry, shared } = await fixture(context);
  await registry.mutate({
    action: "put",
    record: { kind: "globalPreference", preference: { key: "theme", value: "winter" } },
  });
  await Promise.all([registry.readBrowser(BROWSER_A), registry.readBrowser(BROWSER_A)]);
  await registry.readBrowser(BROWSER_B);
  await registry.mutateBrowser(BROWSER_A, {
    action: "put",
    record: { kind: "globalPreference", preference: { key: "theme", value: "magical-girl" } },
  });
  await registry.mutateBrowser(BROWSER_A, {
    action: "put",
    record: { kind: "globalPreference", preference: { key: "transcriptProjectionMode", value: "sqlite" } },
  });

  assert.equal(globalPreference(records(await registry.readBrowser(BROWSER_A)), "theme")?.preference.value, "magical-girl");
  assert.equal(globalPreference(records(await registry.readBrowser(BROWSER_A)), "transcriptProjectionMode")?.preference.value, "sqlite");
  assert.equal(globalPreference(records(await registry.readBrowser(BROWSER_B)), "theme")?.preference.value, "winter");
  assert.deepEqual(
    (await fs.readdir(path.join(directory, "browser-state"))).filter((name) => name === `${BROWSER_A}.sqlite3`),
    [`${BROWSER_A}.sqlite3`],
  );

  await registry.close();
  await assert.rejects(registry.readBrowser(BROWSER_A), /registry is closed/u);
  const reopened = new WorkbenchBrowserStateRegistry(shared, {
    browserStateDirectoryPath: path.join(directory, "browser-state"),
  });
  reopened.start();
  assert.equal(globalPreference(records(await reopened.readBrowser(BROWSER_A)), "theme")?.preference.value, "magical-girl");
  assert.equal(globalPreference(records(await reopened.readBrowser(BROWSER_A)), "transcriptProjectionMode")?.preference.value, "sqlite");
  await reopened.close();
});

test("portable settings refresh the seed, drafts do not, and new browsers wait for the seed", async (context) => {
  const { registry } = await fixture(context);
  const browserAState = await registry.readBrowser(BROWSER_A);
  await registry.mutateBrowser(BROWSER_A, {
    action: "put",
    record: { kind: "globalPreference", preference: { key: "editorSpellCheck", value: true } },
  });
  const browserC = records(await registry.readBrowser(BROWSER_C));
  assert.equal(globalPreference(browserC, "editorSpellCheck")?.preference.value, true);

  await registry.mutateBrowser(BROWSER_A, {
    action: "put",
    record: {
      daemonRegistrationId: browserAState.daemonRegistrationId,
      kind: "composerDraft",
      projectId: "project",
      threadId: "thread",
      value: { attachments: [], text: "private draft", updatedAt: 10 },
    },
  });
  await registry.mutateBrowser(BROWSER_A, {
    action: "put",
    record: { kind: "globalPreference", preference: { key: "appPort", value: 43_210 } },
  });
  await registry.mutateBrowser(BROWSER_A, {
    action: "put",
    record: { kind: "globalPreference", preference: { key: "reactDevelopmentMode", value: true } },
  });
  const browserD = records(await registry.readBrowser(BROWSER_D));
  assert.equal(browserD.some((record) => record.kind === "composerDraft"), false);
  assert.equal(globalPreference(browserD, "appPort"), undefined);
  assert.equal(globalPreference(browserD, "reactDevelopmentMode"), undefined);
});

test("missing IDs use shared state and invalid IDs never create browser storage", async (context) => {
  const { directory, registry } = await fixture(context);
  await registry.mutateBrowser(undefined, {
    action: "put",
    record: { kind: "globalPreference", preference: { key: "composerSpellCheck", value: true } },
  });
  assert.equal(
    globalPreference(records(await registry.readBrowser(undefined)), "composerSpellCheck")?.preference.value,
    true,
  );

  await assert.rejects(registry.readBrowser("../../escape"), /ID is invalid/u);
  await assert.rejects(fs.access(path.join(directory, "browser-state")), /ENOENT/u);
});

test("seed failures are diagnosed without rolling back browser commits", async (context) => {
  const { diagnostics, registry, shared } = await fixture(context);
  await registry.readBrowser(BROWSER_A);
  await shared.close();
  await registry.mutateBrowser(BROWSER_A, {
    action: "put",
    record: { kind: "globalPreference", preference: { key: "theme", value: "magical-girl" } },
  });
  assert.equal(globalPreference(records(await registry.readBrowser(BROWSER_A)), "theme")?.preference.value, "magical-girl");
  await registry.close();
  assert.match(diagnostics[0] ?? "", /seed refresh failed/u);
});

test("failed clones never promote partial browser databases", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-browser-state-failure-"));
  class FailingBackupRepository extends WorkbenchAppStateRepository {
    override async backupTo(destinationPath: string) {
      await fs.writeFile(destinationPath, "partial", "utf8");
      throw new Error("backup failed");
    }
  }
  const shared = new FailingBackupRepository({
    databasePath: path.join(directory, "app-state.sqlite3"),
  });
  await shared.start();
  const browserStateDirectoryPath = path.join(directory, "browser-state");
  const registry = new WorkbenchBrowserStateRegistry(shared, { browserStateDirectoryPath });
  registry.start();
  context.after(async () => {
    await registry.close();
    await shared.close();
    await fs.rm(directory, { force: true, recursive: true });
  });

  await assert.rejects(registry.readBrowser(BROWSER_A), /backup failed/u);
  assert.deepEqual(await fs.readdir(browserStateDirectoryPath), []);
});
