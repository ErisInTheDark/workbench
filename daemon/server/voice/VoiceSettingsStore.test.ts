/* Exports: none. Protect durable independent model selection and write ordering. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import WorkbenchDatabaseController from "../database/WorkbenchDatabaseController";
import WorkbenchComposerProfileStore from "../WorkbenchComposerProfileStore";
import VoiceSettingsStore from "./VoiceSettingsStore";
import type { WorkbenchComposerProfile, WorkbenchComposerSettings } from "workbench-shared/types";
import { upsertRow } from "workbench-shared/database/workbench-database-statements";
import { voiceProfileLink, voiceSettings } from "../lib/workbench/database/schema/voice-settings-schema";

const settings: WorkbenchComposerSettings = {
  harness: "codex", model: "original", agentPath: null, agentSource: null, reasoningEffort: "none", serviceTier: null,
};
const definition: WorkbenchComposerProfile = { ...settings, id: "voice", name: "Voice", scope: { kind: "global" }, createdAt: 1, updatedAt: 1 };
async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-settings-"));
  const database = new WorkbenchDatabaseController({ databasePath: path.join(root, "database.sqlite3") });
  const profiles = new WorkbenchComposerProfileStore(database);
  context.after(async () => { await profiles.dispose(); await database.close(); await rm(root, { recursive: true, force: true }); });
  return { database, profiles, store: new VoiceSettingsStore(database) };
}
test("voice retains its saved model independently of profile edits and deletion", async context => {
  const { profiles, store, database } = await fixture(context);
  await profiles.mutate({ kind: "upsert", profile: definition });
  await store.write({ selection: { kind: "profile", profileId: definition.id, settings } });
  // Reopen the shape persisted by the earlier profile-based implementation.
  await database.executeTransaction([
    upsertRow(voiceSettings, {
      id: "voice", harness: "codex", model: "original", agent_path: "library:agents/old.md",
      agent_source: "library", reasoning_effort: "high", service_tier: "fast", context_window_tokens: 123456,
    }, { conflictColumns: ["id"], updateColumns: ["agent_path", "agent_source", "reasoning_effort", "service_tier", "context_window_tokens"] }),
    upsertRow(voiceProfileLink, { id: "voice", profile_id: definition.id }, { conflictColumns: ["id"], updateColumns: ["profile_id"] }),
  ]);
  await profiles.mutate({ kind: "upsert", profile: { ...definition, model: "updated", updatedAt: 2 } });
  assert.deepEqual(await store.resolve(), { harness: "codex", model: "original" });
  await profiles.mutate({ kind: "delete", profileId: definition.id });
  const reopened = new VoiceSettingsStore(database);
  assert.equal((await reopened.read()).selection?.kind, "custom");
  assert.equal((await reopened.resolve()).model, "original");
  await store.write({ selection: null });
  assert.deepEqual(await reopened.read(), { selection: null });
});
test("a slow save cannot overwrite a later disable", async context => {
  const { database } = await fixture(context);
  let entered!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const store = new VoiceSettingsStore({
    query: statement => database.query(statement),
    async executeTransaction(statements) { entered(); await pending; return database.executeTransaction(statements); },
  });
  const first = store.write({ selection: { kind: "profile", profileId: definition.id, settings } });
  await reading;
  const later = store.write({ selection: null });
  release();
  await Promise.all([first, later]);
  assert.deepEqual(await store.read(), { selection: null });
});
