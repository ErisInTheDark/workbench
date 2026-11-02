/* No production exports. Tests protect which project a feedback submission is recorded against. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchFeedbackRecord } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import WorkbenchFeedbackCommandController from "./WorkbenchFeedbackCommandController";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("feedback-command-");
  context.after(() => temporary.dispose());
  const app = path.join(temporary.path, "app");
  const library = path.join(temporary.path, "library");
  await fs.mkdir(path.join(library, "src"), { recursive: true });
  await fs.mkdir(app);
  await fs.writeFile(path.join(library, "src", "index.ts"), "");
  const recorded: WorkbenchFeedbackRecord[] = [];
  const resolved: string[] = [];
  const controller = new WorkbenchFeedbackCommandController({
    resolveCaller: async () => ({
      harness: "claude", model: null, projectId: testProjectIds.project, reasoningEffort: null, threadId: WorkbenchThreadIdSchema.parse("thread"),
    }),
    resolveProjectId: async (cwd) => {
      resolved.push(cwd);
      if (!cwd.startsWith(library)) throw new Error("Feedback path cwd must be inside a discovered Workbench project.");
      return testProjectIds.other;
    },
    projectName: () => null,
    record: async (entry) => recorded.push(entry),
    read: async () => ({ page: 1, pages: 1, rows: [] }),
  });
  const submit = (input: object) => controller.submit({
    category: "bug", channel: "project", cwd: app, harness: "claude", report: "broken", threadId: "thread", title: "Broken", ...input,
  }, new AbortController().signal);
  return { library, recorded, resolved, submit };
}

test("project feedback defaults to the caller's project", async (context) => {
  const { recorded, submit } = await fixture(context);
  assert.equal((await submit({})).status, 200);
  assert.equal(recorded[0]?.projectId, testProjectIds.project);
});

test("a path relative to the caller's cwd, or a file in it, records against the project owning that path", async (context) => {
  const { library, recorded, resolved, submit } = await fixture(context);
  assert.equal((await submit({ path: "../library" })).status, 200);
  assert.equal((await submit({ path: "../library/src/index.ts" })).status, 200);
  assert.deepEqual(recorded.map(({ projectId }) => projectId), [testProjectIds.other, testProjectIds.other]);
  assert.deepEqual(resolved, [library, path.join(library, "src")]);
});

test("unusable paths answer the agent and record nothing", async (context) => {
  const { recorded, submit } = await fixture(context);
  assert.equal((await submit({ channel: "wb", path: "../library" })).status, 400);
  assert.equal((await submit({ path: "../missing" })).status, 400);
  await assert.rejects(submit({ path: "." }), /discovered Workbench project/u);
  assert.equal(recorded.length, 0);
});
