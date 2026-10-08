/* No production exports. Tests protect silent goal notices delivered at once or on the agent's next input, re-send after compaction, and observer publication. */
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchContextAdmission } from "workbench-shared/workbench/provider/provider-context";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import type { WorkbenchThreadGoal } from "workbench-shared/workbench/thread/thread-goal";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadGoalStore from "./database/goals/WorkbenchThreadGoalStore";
import WorkbenchThreadGoalController from "./WorkbenchThreadGoalController";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("thread-goals-");
  const database = new Database(path.join(temporary.path, "state.sqlite"));
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(async () => { database.close(); await temporary.dispose(); });
  const threadId = new WorkbenchThreadIdentityRepository(database).observe({
    native: { harness: "claude", nativeLocation: temporary.path, nativeThreadId: NativeThreadIdSchema.parse("native") },
    projectId: testProjectIds.fixture, projectRoot: temporary.path,
    title: "thread", createdAt: 1, updatedAt: 1, activityAt: 1,
  }).threadId;
  const store = new WorkbenchThreadGoalStore(database);
  const published: string[] = [];
  const changes: (WorkbenchThreadGoal | null)[] = [];
  let admission: WorkbenchContextAdmission = "admitted";
  const target = { harness: "claude" as const, threadId };
  const controller = new WorkbenchThreadGoalController({
    store: async command => store.execute(command),
    target: async () => target,
    publish: async (_target, text) => {
      if (admission === "admitted") published.push(text);
      return admission;
    },
    changed: (_threadId, goal) => { changes.push(goal); },
    warn: message => { throw new Error(`unexpected warning: ${message}`); },
    now: () => 1,
  });
  const collectNextInput = async () => {
    for (const contribution of await controller.contextSource.collect(target, "start", new AbortController().signal)) {
      published.push(contribution.text);
      await contribution.admitted?.();
    }
  };
  return { controller, threadId, published, changes, collectNextInput, setAdmission: (value: WorkbenchContextAdmission) => { admission = value; } };
}

test("setting and clearing a goal tells the agent silently at once and publishes the new value", async context => {
  const { controller, threadId, published, changes } = await fixture(context);
  assert.equal((await controller.set(threadId, " finish the port "))?.objective, "finish the port");
  assert.equal(published.length, 1);
  assert.match(published[0]!, /^<wb:goal-updated>[\s\S]*Do not acknowledge this notice visibly[\s\S]*finish the port/u);
  await controller.clear(threadId);
  assert.match(published[1]!, /^<wb:goal-cleared>/u);
  assert.deepEqual(changes.map(goal => goal?.objective ?? null), ["finish the port", null]);
  assert.equal(await controller.read(threadId), null);
  await controller.observeCompaction(threadId);
  assert.equal(published.length, 2, "a cleared goal is never re-sent");
});

test("unsupported injection waits for the agent's next input, then compaction re-sends the goal once", async context => {
  const { controller, threadId, published, collectNextInput, setAdmission } = await fixture(context);
  setAdmission("unsupported");
  await controller.set(threadId, "goal");
  assert.deepEqual(published, []);
  await collectNextInput();
  assert.equal(published.length, 1);
  await collectNextInput();
  assert.equal(published.length, 1, "an admitted notice is acknowledged");
  setAdmission("admitted");
  await controller.observeCompaction(threadId);
  assert.match(published[1]!, /^<wb:goal>[\s\S]*goal/u);
  await collectNextInput();
  assert.equal(published.length, 2);
});

test("a goal objective must be non-empty and bounded", async context => {
  const { controller, threadId } = await fixture(context);
  await assert.rejects(controller.set(threadId, "   "));
  await assert.rejects(controller.set(threadId, "x".repeat(4_001)));
});
