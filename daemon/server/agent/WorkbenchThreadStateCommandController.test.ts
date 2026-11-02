/*
 * No production exports. Tests thread_state ordering: a refused mode or status applies nothing else, a refused title
 * stops the status, and an accepted call retitles before setting status.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import type { WorkflowLedgerEntry, WorkflowMode } from "workbench-shared/workbench/thread/workflow-modes";
import WorkbenchThreadStateCommandController from "./WorkbenchThreadStateCommandController";

const review: ProofOfWorkChecklist = { id: "review", hidden: false, items: [{ id: "review.coverage", label: "Coverage" }] };
const reviewMode: WorkflowMode = { name: "Review", icon: "flag", color: null, proofs: ["review"], resetOn: ["Brief"], from: [], status: "completed", deny: [] };

function fixture(ledger: WorkflowLedgerEntry[] = [], { titleFails = false } = {}) {
  const applied: string[] = [];
  const controller = new WorkbenchThreadStateCommandController({
    resolveCaller: async ({ threadId }) => ({ threadId }),
    readWorkflow: async () => ({
      overlays: { checklists: [review], modes: [reviewMode] }, ledger, mode: "Implement", definition: null, alwaysEditable: [], projectRoot: null,
    }),
    readTurnItems: async () => [],
    readTitle: async () => "Title",
    setTitle: async (_caller, title) => {
      if (titleFails) throw new Error("Thread title mismatch.");
      applied.push(`title:${title}`);
    },
    readStatus: async () => "working",
    setStatus: async (_caller, status) => { applied.push(`status:${status}`); },
  });
  const call = async (state: object) => {
    const response = await controller.execute({ cwd: "C:/project", harness: "claude", threadId: "thread", state }, new AbortController().signal);
    return { status: response.status, body: await response.text() };
  };
  return { applied, call };
}

test("an unresolved gate refuses the whole call but says its proofs were filed", async () => {
  const { applied, call } = fixture();
  const result = await call({ notApplicable: [], mode: "Review", status: "completed", title: "New" });
  assert.equal(result.status, 400);
  assert.deepEqual(applied, []);
  assert.match(result.body, /review\.coverage/u);
});

test("entering the paired mode needs completion in the same call, and completion needs the paired mode", async () => {
  const { applied, call } = fixture();
  assert.equal((await call({ proofs: { "review.coverage": "ok" }, mode: "Review" })).status, 400);
  assert.equal((await call({ status: "completed" })).status, 400);
  assert.equal((await call({ status: "blocked" })).status, 200);
  assert.deepEqual(applied, ["status:blocked"]);
});

test("an accepted call retitles before setting status; a refused title stops the status", async () => {
  const accepted = fixture();
  const ok = await accepted.call({ proofs: { "review.coverage": "ok" }, mode: "Review", status: "completed", title: "New" });
  assert.equal(ok.status, 200);
  assert.deepEqual(accepted.applied, ["title:New", "status:completed"]);

  const refused = fixture([], { titleFails: true });
  const result = await refused.call({ proofs: { "review.coverage": "ok" }, mode: "Review", status: "completed", title: "New" });
  assert.equal(result.status, 400);
  assert.deepEqual(refused.applied, []);
});

test("invalid proofs are rejected before anything runs", async () => {
  const { applied, call } = fixture();
  assert.equal((await call({ proofs: { "review.coverage": "ok" }, notApplicable: ["review.coverage"], status: "blocked" })).status, 400);
  assert.deepEqual(applied, []);
});
