/* No production exports. Tests protect immediate and next-input delivery of compaction re-sends and deactivation notices, and acknowledgement only after admission. */
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchContextAdmission } from "workbench-shared/workbench/provider/provider-context";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import {
  WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER,
  WORKBENCH_SKILL_DEACTIVATED_TAG_WRAPPER,
} from "workbench-shared/workbench/thread/thread-activated-skills";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadSkillStore from "./database/skills/WorkbenchThreadSkillStore";
import WorkbenchThreadSkillsController from "./WorkbenchThreadSkillsController";

const known = new Map([["skills/react/SKILL.md", "react"], ["skills/review/SKILL.md", "review"]]);

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("thread-skills-");
  const database = new Database(path.join(temporary.path, "state.sqlite"));
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(async () => { database.close(); await temporary.dispose(); });
  const threadId = new WorkbenchThreadIdentityRepository(database).observe({
    native: { harness: "claude", nativeLocation: temporary.path, nativeThreadId: NativeThreadIdSchema.parse("native") },
    projectId: testProjectIds.fixture, projectRoot: temporary.path,
    title: "thread", createdAt: 1, updatedAt: 1, activityAt: 1,
  }).threadId;
  const store = new WorkbenchThreadSkillStore(database);
  const published: string[] = [];
  const broadcasts: WorkbenchThreadSkill[][] = [];
  let admission: WorkbenchContextAdmission = "admitted";
  const target = { harness: "claude" as const, threadId };
  const controller = new WorkbenchThreadSkillsController({
    store: async command => store.execute(command),
    target: async () => target,
    resolve: async (_target, paths) => paths.flatMap(value => known.has(value) ? [{ path: value, name: known.get(value)! }] : []),
    buildCatalog: async (_target, paths) => paths.map(value => `<skill name="${known.get(value)}">body</skill>`).join("\n"),
    publish: async (_target, text) => {
      if (admission === "admitted") published.push(text);
      return admission;
    },
    broadcast: (_target, skills) => { broadcasts.push([...skills]); },
    warn: message => { throw new Error(`unexpected warning: ${message}`); },
    now: () => 1,
  });
  return {
    controller, target, threadId, published, broadcasts,
    setAdmission: (value: WorkbenchContextAdmission) => { admission = value; },
  };
}

test("a live thread receives active skills again after each compaction, with the previously-activated note", async context => {
  const { controller, threadId, published, broadcasts } = await fixture(context);
  await controller.recordActivations(threadId, ["skills/react/SKILL.md", "skills/missing/SKILL.md"], "user");
  await controller.recordActivations(threadId, ["skills/review/SKILL.md"], "agent");
  assert.deepEqual((await controller.read(threadId)).map(skill => [skill.name, skill.source]), [["react", "user"], ["review", "agent"]]);
  assert.equal(broadcasts.length, 2);

  await controller.observeCompaction(threadId);
  assert.equal(published.length, 1);
  const body = WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER.read(published[0]!)?.body ?? "";
  assert.match(body, /previously activated/u);
  assert.match(body, /name="react"[\s\S]*name="review"/u);
  await controller.observeCompaction(threadId);
  assert.equal(published.length, 2, "every compaction re-sends; acknowledgement cleared the first one");
});

test("an idle thread keeps a deactivation notice pending until its next input admits it", async context => {
  const { controller, target, threadId, published, broadcasts, setAdmission } = await fixture(context);
  await controller.recordActivations(threadId, ["skills/react/SKILL.md", "skills/review/SKILL.md"], "user");
  setAdmission("unsupported");
  const remaining = await controller.deactivate(threadId, "skills/react/SKILL.md");
  assert.deepEqual(remaining.map(skill => skill.name), ["review"]);
  assert.deepEqual(broadcasts.at(-1)?.map(skill => skill.name), ["review"]);
  assert.equal(published.length, 0);

  const contributions = await controller.contextSource.collect(target, "start", new AbortController().signal);
  assert.equal(contributions.length, 1);
  assert.equal(WORKBENCH_SKILL_DEACTIVATED_TAG_WRAPPER.read(contributions[0]!.text)?.attributes.name, "react");
  // Collection alone is not delivery: an unadmitted contribution must be offered again.
  assert.equal((await controller.contextSource.collect(target, "start", new AbortController().signal)).length, 1);
  await contributions[0]!.admitted?.();
  assert.deepEqual(await controller.contextSource.collect(target, "start", new AbortController().signal), []);
});
