/* No production exports. Tests protect which instruction selection a message launches with and when it is recorded. */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchInstructionSelection } from "workbench-shared/workbench/provider/provider-input";
import WorkbenchThreadInstructionSelectionController from "./WorkbenchThreadInstructionSelectionController";

const threadId = WorkbenchThreadIdSchema.parse("thread");

function fixture(kind: "thread" | "subagent", options: { stored?: WorkbenchInstructionSelection; failWrites?: boolean } = {}) {
  const warnings: string[] = [];
  let stored = options.stored ?? null;
  const owner = new WorkbenchThreadInstructionSelectionController({
    store: async command => {
      if (command.kind === "record") {
        if (options.failWrites) throw new Error("disk full");
        stored = command.selection;
      }
      return stored;
    },
    readThreadKind: async () => kind,
    now: () => 1,
    warn: message => { warnings.push(message); },
  });
  return { owner, warnings, stored: () => stored };
}

test("a thread with no recorded selection launches with its kind's default workflow", async () => {
  assert.deepEqual(await fixture("thread").owner.resolve(threadId, undefined), { workflowIds: ["default"] });
  assert.deepEqual(await fixture("subagent").owner.resolve(threadId, { activatedSkillPaths: ["skills/a"] }), {
    workflowIds: ["subagent"], activatedSkillPaths: ["skills/a"],
  });
});

test("an explicit empty workflow choice is a selection: it launches as sent and is remembered", async () => {
  const { owner, stored } = fixture("thread", { stored: { workflowIds: ["review"] } });
  assert.deepEqual(await owner.resolve(threadId, { workflowIds: [] }), { workflowIds: [] });
  await owner.record(threadId, { workflowIds: [], activatedSkillPaths: ["skills/a"] });
  assert.deepEqual(stored(), { workflowIds: [] });
  await owner.record(threadId, { activatedSkillPaths: ["skills/b"] });
  assert.deepEqual(stored(), { workflowIds: [] });
});

test("a failed record only warns, since its message already landed", async () => {
  const { owner, warnings } = fixture("thread", { failWrites: true });
  await owner.record(threadId, { workflowIds: ["review"] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /disk full/u);
});
