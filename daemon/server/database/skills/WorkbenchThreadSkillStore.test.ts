/* No production exports. Tests protect thread-skill activation, deactivation and compaction notices, and acknowledgement that never eats newer transitions. */
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadSkillStore from "./WorkbenchThreadSkillStore";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-store-");
  const database = new Database(path.join(temporary.path, "state.sqlite"));
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(async () => { database.close(); await temporary.dispose(); });
  const identities = new WorkbenchThreadIdentityRepository(database);
  const [threadId, otherThreadId] = ["one", "two"].map(native => identities.observe({
    native: { harness: "claude", nativeLocation: temporary.path, nativeThreadId: NativeThreadIdSchema.parse(native) },
    projectId: testProjectIds.fixture, projectRoot: temporary.path,
    title: native, createdAt: 1, updatedAt: 1, activityAt: 1,
  }).threadId);
  return { store: new WorkbenchThreadSkillStore(database), threadId: threadId!, otherThreadId: otherThreadId! };
}

const react = { path: "skills/react/SKILL.md", name: "react", source: "user" as const };
const review = { path: "skills/review/SKILL.md", name: "review", source: "agent" as const };
const names = (skills: readonly { name: string }[]) => skills.map(skill => skill.name);

test("compaction marks every active skill for re-delivery, and acknowledgement clears only the delivered paths", async context => {
  const { store, threadId, otherThreadId } = await fixture(context);
  store.execute({ kind: "activate", threadId, skills: [react, review], at: 1 });
  store.execute({ kind: "activate", threadId: otherThreadId, skills: [react], at: 1 });
  const compacted = store.execute({ kind: "markCompacted", threadId });
  assert.deepEqual(names(compacted.pending.redeliver), ["react", "review"]);
  assert.deepEqual(store.execute({ kind: "read", threadId: otherThreadId }).pending.redeliver, []);
  const acknowledged = store.execute({ kind: "acknowledge", threadId, notice: "redeliver", paths: [react.path] });
  assert.deepEqual(names(acknowledged.pending.redeliver), ["review"]);
  assert.deepEqual(names(acknowledged.skills), ["react", "review"]);
});

test("deactivation hides the skill at once and keeps its notice until delivery; reactivation cancels it", async context => {
  const { store, threadId } = await fixture(context);
  store.execute({ kind: "activate", threadId, skills: [react, review], at: 1 });
  store.execute({ kind: "markCompacted", threadId });
  const deactivated = store.execute({ kind: "deactivate", threadId, path: react.path });
  assert.deepEqual(names(deactivated.skills), ["review"]);
  assert.deepEqual(names(deactivated.pending.deactivated), ["react"]);
  assert.deepEqual(names(deactivated.pending.redeliver), ["review"], "a deactivated skill is never re-sent");
  // A stale redelivery acknowledgement must not resurrect or clear the deactivation.
  assert.deepEqual(names(store.execute({ kind: "acknowledge", threadId, notice: "redeliver", paths: [react.path] }).pending.deactivated), ["react"]);

  const reactivated = store.execute({ kind: "activate", threadId, skills: [react], at: 2 });
  assert.deepEqual(names(reactivated.skills).sort(), ["react", "review"]);
  assert.deepEqual(reactivated.pending.deactivated, []);
  // Acknowledging the cancelled deactivation must not delete the reactivated skill.
  assert.deepEqual(names(store.execute({ kind: "acknowledge", threadId, notice: "deactivated", paths: [react.path] }).skills).sort(), ["react", "review"]);

  store.execute({ kind: "deactivate", threadId, path: react.path });
  const delivered = store.execute({ kind: "acknowledge", threadId, notice: "deactivated", paths: [react.path] });
  assert.deepEqual(delivered.pending.deactivated, []);
  assert.deepEqual(names(delivered.skills), ["review"]);
});
