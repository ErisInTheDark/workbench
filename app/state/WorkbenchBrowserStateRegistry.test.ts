/*
 * No production exports. Real SQLite wards protect browser database cloning, isolation, seed refresh, failure cleanup, and disposal. Keywords: browser, state, registry, SQLite.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { projectWorkbenchClientStateRows } from "workbench-shared/state/workbench-client-state-projection";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";

import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import WorkbenchBrowserStateRegistry from "./WorkbenchBrowserStateRegistry.ts";

const BROWSER_A = "10000000-0000-4000-8000-000000000001";
const BROWSER_B = "20000000-0000-4000-8000-000000000002";
const BROWSER_C = "30000000-0000-4000-8000-000000000003";
const BROWSER_D = "40000000-0000-4000-8000-000000000004";

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
  shared.start();
  const diagnostics: string[] = [];
  const registry = new WorkbenchBrowserStateRegistry(shared, {
    browserStateDirectoryPath: path.join(directory, "browser-state"),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  registry.start();
  context.after(async () => {
    await registry.close();
    shared.close();
    await fs.rm(directory, { force: true, recursive: true });
  });
  return { diagnostics, directory, registry, shared };
}

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

  assert.equal(globalPreference(records(await registry.readBrowser(BROWSER_A)), "theme")?.preference.value, "magical-girl");
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
  shared.close();
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
  shared.start();
  const browserStateDirectoryPath = path.join(directory, "browser-state");
  const registry = new WorkbenchBrowserStateRegistry(shared, { browserStateDirectoryPath });
  registry.start();
  context.after(async () => {
    await registry.close();
    shared.close();
    await fs.rm(directory, { force: true, recursive: true });
  });

  await assert.rejects(registry.readBrowser(BROWSER_A), /backup failed/u);
  assert.deepEqual(await fs.readdir(browserStateDirectoryPath), []);
});
