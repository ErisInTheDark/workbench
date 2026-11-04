/*
 * No production exports. Tests protect next-input first delivery of user activations, immediate and next-input delivery of
 * compaction re-sends and deactivation notices, incremental skill list notices (and their refreeze after compaction), and
 * acknowledgement only after admission.
 */
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
  WORKBENCH_SKILLS_CHANGED_TAG_WRAPPER,
} from "workbench-shared/workbench/thread/thread-activated-skills";
import type { WorkbenchSkillCatalogEntry } from "../lib/workbench-library";
import type { PinnedSkills } from "./WorkbenchThreadInstructionPins";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import { installWorkbenchDatabaseSchema } from "../database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadSkillStore from "../database/skills/WorkbenchThreadSkillStore";
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
  /** The pinned list (null: no prefix froze one) and the project's live list. */
  const skillList: { pinned: PinnedSkills | null; live: WorkbenchSkillCatalogEntry[] } = { pinned: null, live: [] };
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
    readSkillList: async () => skillList.pinned && structuredClone(skillList.pinned),
    listSkills: async () => structuredClone(skillList.live),
    noteSkills: async (_target, entries) => { if (skillList.pinned) skillList.pinned.known = structuredClone(entries); },
    refreezeSkills: async () => {
      if (skillList.pinned) skillList.pinned = { ...skillList.pinned, known: skillList.pinned.frozen, refreeze: true };
    },
    warn: message => { throw new Error(`unexpected warning: ${message}`); },
    now: () => 1,
  });
  return {
    controller, target, threadId, published, broadcasts, skillList,
    setAdmission: (value: WorkbenchContextAdmission) => { admission = value; },
  };
}

test("a user activation owes its body until the agent's next input admits it; an agent activation owes nothing", async context => {
  const { controller, target, threadId, published } = await fixture(context);
  await controller.recordActivations(threadId, ["skills/review/SKILL.md"], "agent");
  assert.deepEqual(await controller.contextSource.collect(target, "start", new AbortController().signal), []);
  await controller.recordActivations(threadId, ["skills/react/SKILL.md"], "user");
  const [first, ...rest] = await controller.contextSource.collect(target, "start", new AbortController().signal);
  assert.deepEqual(rest, []);
  const body = WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER.read(first!.text)?.body ?? "";
  assert.match(body, /name="react"/u);
  assert.doesNotMatch(body, /previously activated|name="review"/u);
  assert.equal(published.length, 0, "activation waits for an input boundary instead of publishing");
  await first!.admitted?.();
  assert.deepEqual(await controller.contextSource.collect(target, "steer", new AbortController().signal), []);
});

test("a live thread receives active skills again after each compaction, with the previously-activated note", async context => {
  const { controller, threadId, published, broadcasts } = await fixture(context);
  await controller.recordActivations(threadId, ["skills/react/SKILL.md", "skills/missing/SKILL.md"], "agent");
  await controller.recordActivations(threadId, ["skills/review/SKILL.md"], "agent");
  assert.deepEqual((await controller.read(threadId)).map(skill => [skill.name, skill.source]), [["react", "agent"], ["review", "agent"]]);
  assert.equal(broadcasts.length, 2);

  await controller.observeCompaction(threadId);
  assert.equal(published.length, 1);
  const body = WORKBENCH_ACTIVATED_SKILLS_TAG_WRAPPER.read(published[0]!)?.body ?? "";
  assert.match(body, /previously activated/u);
  assert.match(body, /name="react"[\s\S]*name="review"/u);
  await controller.observeCompaction(threadId);
  assert.equal(published.length, 2, "every compaction re-sends; acknowledgement cleared the first one");
});

test("skill list changes reach the agent once, as lines for inactive skills and new bodies for active ones", async context => {
  const { controller, target, threadId, skillList } = await fixture(context);
  const entry = (name: string, digest = "1", trigger = `Use for ${name}.`) => ({ name, trigger, digest });
  const frozen = [entry("react"), entry("review"), entry("old")];
  skillList.pinned = { frozen, known: frozen, refreeze: false };
  skillList.live = frozen;
  await controller.recordActivations(threadId, ["skills/react/SKILL.md"], "agent");
  const collect = () => controller.contextSource.collect(target, "start", new AbortController().signal);
  assert.deepEqual(await collect(), []);

  skillList.live = [entry("react", "2"), entry("review", "2"), entry("new-thing")];
  const [notice, ...rest] = await collect();
  assert.deepEqual(rest, []);
  const body = WORKBENCH_SKILLS_CHANGED_TAG_WRAPPER.read(notice!.text)?.body ?? "";
  assert.match(body, /<skill name="new-thing" trigger="Use for new-thing\." \/>/u);
  assert.match(body, /<skill name="react">body<\/skill>/u, "an active skill's change carries its new body");
  assert.doesNotMatch(body, /review/u, "an inactive skill's body is never listed");
  assert.match(body, /Removed: old/u);
  assert.equal((await collect()).length, 1, "unadmitted notices are offered again");
  await notice!.admitted?.();
  assert.deepEqual(await collect(), []);

  skillList.live = [entry("react", "2"), entry("review", "3"), entry("new-thing")];
  assert.deepEqual(await collect(), [], "an inactive body edit changes nothing the agent sees");
  assert.equal(skillList.pinned.known.find(skill => skill.name === "review")?.digest, "3");
});

test("after compaction the agent is told the list again, without duplicating the active bodies being re-sent", async context => {
  const { controller, threadId, published, skillList } = await fixture(context);
  const entry = (name: string, digest = "1") => ({ name, trigger: `Use for ${name}.`, digest });
  skillList.pinned = { frozen: [entry("react")], known: [entry("react", "2"), entry("new-thing")], refreeze: false };
  skillList.live = [entry("react", "2"), entry("new-thing")];
  await controller.recordActivations(threadId, ["skills/react/SKILL.md"], "agent");

  await controller.observeCompaction(threadId);
  assert.equal(skillList.pinned.refreeze, true, "the next build lists current skills");
  const changed = published.map(text => WORKBENCH_SKILLS_CHANGED_TAG_WRAPPER.read(text)?.body).filter(Boolean);
  assert.equal(changed.length, 1, "a live agent that is not rebuilt is told what its frozen list lacks");
  assert.match(changed[0]!, /name="new-thing"/u);
  assert.doesNotMatch(changed[0]!, /name="react"/u);
  assert.ok(published.some(text => /previously activated[\s\S]*name="react"/u.test(text)));
});

test("a compaction mid-turn tells a live agent what its frozen list lacks right away, even with no active skills", async context => {
  const { controller, threadId, published, skillList } = await fixture(context);
  const entry = (name: string) => ({ name, trigger: `Use for ${name}.`, digest: "1" });
  skillList.pinned = { frozen: [entry("react")], known: [entry("react"), entry("new-thing")], refreeze: false };
  skillList.live = [entry("react"), entry("new-thing")];

  await controller.observeCompaction(threadId);
  assert.equal(published.length, 1);
  assert.match(WORKBENCH_SKILLS_CHANGED_TAG_WRAPPER.read(published[0]!)?.body ?? "", /name="new-thing"/u);
});

test("an idle thread keeps a deactivation notice pending until its next input admits it", async context => {
  const { controller, target, threadId, published, broadcasts, setAdmission } = await fixture(context);
  await controller.recordActivations(threadId, ["skills/react/SKILL.md", "skills/review/SKILL.md"], "agent");
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
