/* Exports: none. Protect durable voice selection, profile fallback and write ordering. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import WorkbenchDatabaseController from "../database/WorkbenchDatabaseController";
import WorkbenchComposerProfileStore from "../WorkbenchComposerProfileStore";
import VoiceSettingsStore from "./VoiceSettingsStore";
import type { WorkbenchComposerProfile, WorkbenchComposerSettings } from "workbench-shared/types";

const settings: WorkbenchComposerSettings = {
  harness: "codex", model: "original", agentPath: null, agentSource: null, reasoningEffort: "none", serviceTier: null,
};
const definition: WorkbenchComposerProfile = { ...settings, id: "voice", name: "Voice", scope: { kind: "global" }, createdAt: 1, updatedAt: 1 };
async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-settings-"));
  const database = new WorkbenchDatabaseController({ databasePath: path.join(root, "database.sqlite3") });
  const profiles = new WorkbenchComposerProfileStore(database);
  context.after(async () => { await profiles.dispose(); await database.close(); await rm(root, { recursive: true, force: true }); });
  return { database, profiles, store: new VoiceSettingsStore(database, profiles) };
}
test("linked definitions update next-session settings and deletion preserves durable fallback", async context => {
  const { profiles, store, database } = await fixture(context);
  await profiles.mutate({ kind: "upsert", profile: definition });
  await store.write({ selection: { kind: "profile", profileId: definition.id, settings } });
  await profiles.mutate({ kind: "upsert", profile: { ...definition, model: "updated", updatedAt: 2 } });
  assert.equal((await store.resolve()).model, "updated");
  await profiles.mutate({ kind: "delete", profileId: definition.id });
  const reopened = new VoiceSettingsStore(database, profiles);
  assert.equal((await reopened.read()).selection?.kind, "custom");
  assert.equal((await reopened.resolve()).model, "original");
  await store.write({ selection: null });
  assert.deepEqual(await reopened.read(), { selection: null });
});
test("a slow linked selection cannot overwrite a later custom selection", async context => {
  const { database } = await fixture(context);
  let entered!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const store = new VoiceSettingsStore(database, { async read() { entered(); await pending; return { profiles: [definition] }; } });
  const first = store.write({ selection: { kind: "profile", profileId: definition.id, settings } });
  await reading;
  const later = store.write({ selection: { kind: "custom", settings: { ...settings, model: "later" } } });
  release();
  await Promise.all([first, later]);
  assert.equal((await store.resolve()).model, "later");
});
