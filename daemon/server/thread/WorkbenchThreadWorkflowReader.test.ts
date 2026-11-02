/*
 * No production exports. Tests mode denials: claimed edits vs gitignored ones, always-editable exemptions, tool denials,
 * and that thread_state and mode-free threads are never denied.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { WorkflowLedgerEntry, WorkflowMode } from "workbench-shared/workbench/thread/workflow-modes";
import WorkbenchThreadWorkflowReader from "./WorkbenchThreadWorkflowReader";

const root = path.resolve("project");
const review: WorkflowMode = { name: "Review", icon: "flag", color: null, proofs: [], resetOn: [], status: null, deny: ["shell", "edit:claims"] };
const locked: WorkflowMode = { ...review, name: "Locked", deny: ["edit"] };

function reader(ledger: WorkflowLedgerEntry[]) {
  return new WorkbenchThreadWorkflowReader({
    readSelection: async () => ({ workflowIds: ["default"] }),
    readSkills: async () => [],
    readProjectRoot: async () => root,
    readLedger: async () => ledger,
    readOverlays: async () => ({ checklists: [], modes: [review, locked] }),
  });
}

const claimed = path.join(root, "src/a.ts");
const ignored = path.join(root, ".workbench/notes.md");
const notes = path.join(root, "docs/plan.md");

test("edit:claims denies claimed Git-visible edits but not gitignored or always-editable ones", async () => {
  const workflow = reader([{ kind: "editable", paths: ["docs/plan.md"] }, { kind: "mode", mode: "Review" }]);
  const denial = await workflow.readEditDenial("t", [claimed, ignored, notes], [claimed, notes]);
  assert.equal([claimed, ignored, notes].map(candidate => denial?.includes(candidate)).join(), "true,false,false");
  assert.equal(await workflow.readEditDenial("t", [ignored, notes], [notes]), null);
});

test("edit denies gitignored edits too, and threads outside any mode are never denied", async () => {
  assert.notEqual(await reader([{ kind: "mode", mode: "Locked" }]).readEditDenial("t", [ignored], []), null);
  assert.equal(await reader([]).readEditDenial("t", [claimed], [claimed]), null);
});

test("a mode denies its listed tools, never thread_state", async () => {
  const workflow = reader([{ kind: "mode", mode: "review" }]);
  assert.notEqual(await workflow.readToolDenial("t", "shell"), null);
  assert.equal(await workflow.readToolDenial("t", "rg"), null);
  assert.equal(await workflow.readToolDenial("t", "thread_state"), null);
});
