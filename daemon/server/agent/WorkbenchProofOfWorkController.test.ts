/*
 * No production exports. Tests proof feedback across a turn's filings, rejection of undeclared items and unregistered checklists.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ProofOfWork, ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import WorkbenchProofOfWorkController from "./WorkbenchProofOfWorkController";

const plan: ProofOfWorkChecklist = {
  id: "plan",
  hidden: false,
  items: [{ id: "plan.result", label: "Result" }, { id: "plan.failure", label: "Failure" }, { id: "plan.verify", label: "Verify" }],
};

function call(proof: ProofOfWork, status: "completed" | "failed" = "completed"): ThreadItem {
  return {
    type: "mcpToolCall", id: crypto.randomUUID(), server: "wb", tool: "proof_of_work", status, arguments: proof,
    appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
  };
}

function controller(items: readonly ThreadItem[]) {
  return new WorkbenchProofOfWorkController({
    resolveCaller: async () => ({ threadId: "thread", projectRoot: null }),
    readCatalogue: async () => [plan],
    readTurnItems: async () => items,
  });
}

async function submit(items: readonly ThreadItem[], proof: object) {
  const response = await controller(items).execute({ cwd: ".", harness: "codex", threadId: "thread", proof }, new AbortController().signal);
  return { status: response.status, text: await response.text() };
}

test("feedback counts earlier filings in the turn and keeps deferred items open", async () => {
  const earlier = [
    call({ proofs: { "plan.result": "done" }, defer: ["plan.failure", "plan.verify"] }),
    call({ notApplicable: ["plan.verify"] }, "failed"),
  ];
  assert.deepEqual(await submit(earlier, { notApplicable: ["plan.failure"] }), {
    status: 200,
    text: "Recorded.\nplan: 2/3 resolved. Deferred: plan.verify.\n",
  });
  assert.equal((await submit(earlier, { notApplicable: ["plan.failure", "plan.verify"] })).text, "Recorded.\nplan: complete.\n");
});

test("missing items are reported, undeclared ids are rejected, unregistered checklists pass", async () => {
  assert.equal((await submit([], { proofs: { "plan.result": "done" } })).text,
    "Recorded.\nplan: 1/3 resolved. Missing: plan.failure, plan.verify. File or defer them.\n");
  const rejected = await submit([], { proofs: { "plan.typo": "x" } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.text, /Unknown checklist ids: plan\.typo/u);
  assert.equal((await submit([], { proofs: { "custom.one": "x" } })).text,
    "Recorded.\nUnregistered checklists: custom; filed without coverage checks. Registered: plan.\n");
});
