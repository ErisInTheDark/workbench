/*
 * No production exports. Tests thread_state ordering: a refused, undeclared, unpaired, unannounced or unrecovered mode or status applies nothing else, a refused title
 * stops the status, an accepted call retitles before setting status, and process documents are admitted first and backed up on a mode switch.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import type { WorkflowLedgerEntry, WorkflowMode } from "workbench-shared/workbench/thread/workflow-modes";
import WorkbenchThreadStateCommandController from "./WorkbenchThreadStateCommandController";

const review: ProofOfWorkChecklist = { id: "review", hidden: false, items: [{ id: "review.coverage", label: "Coverage" }] };
const reviewMode: WorkflowMode = {
  name: "Review", icon: "flag", color: null, proofs: ["review"], resetOn: ["Brief"], from: [], after: null, status: "completed", deny: [],
};
const implementMode: WorkflowMode = { name: "Implement", icon: "pen", color: null, proofs: [], resetOn: [], from: [], after: "message", status: null, deny: [] };

function fixture(ledger: WorkflowLedgerEntry[] = [], {
  titleFails = false, listed = [] as readonly string[], admitFails = false, backupFails = false, backedUp = true,
} = {}) {
  const applied: string[] = [];
  const controller = new WorkbenchThreadStateCommandController({
    resolveCaller: async ({ threadId }) => ({ threadId }),
    readWorkflow: async () => ({
      overlays: { checklists: [review], modes: [reviewMode, implementMode] }, ledger, mode: "Implement", definition: null, processDocuments: listed, projectRoot: null,
    }),
    admitProcessDocuments: async (_caller, paths) => {
      if (admitFails) throw new Error("Tracked files cannot be process documents.");
      applied.push(`admit:${paths.join()}`);
    },
    backupProcessDocuments: async (_caller, paths) => {
      if (backupFails) throw new Error("disk full");
      applied.push(`backup:${paths.join()}`);
      return backedUp ? ["commit"] : [];
    },
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

test("after a compaction a checklist-gated mode is refused until a recall follows it, applying nothing else", async () => {
  const entering = { proofs: { "review.coverage": "ok" }, mode: "Review", status: "completed" };
  const compacted = fixture([{ kind: "mode", mode: "Implement" }, { kind: "compaction" }]);
  const refused = await compacted.call(entering);
  assert.equal(refused.status, 400);
  assert.match(refused.body, /thread_recall/u);
  assert.deepEqual(compacted.applied, []);
  const recovered = fixture([{ kind: "mode", mode: "Implement" }, { kind: "compaction" }, { kind: "recall" }]);
  assert.equal((await recovered.call(entering)).status, 200);
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

test("an undeclared mode is refused with the declared ones, applying nothing else", async () => {
  const { applied, call } = fixture();
  const result = await call({ mode: "Fixing", title: "New" });
  assert.equal(result.status, 400);
  assert.match(result.body, /Unknown mode "Fixing"; declared: Review, Implement\./u);
  assert.deepEqual(applied, []);
});

test("a mode entered only after a message refuses a silent hop, applying nothing else, and admits once something was said", async () => {
  const silent = fixture([{ kind: "mode", mode: "Review" }]);
  const result = await silent.call({ mode: "Implement", title: "New" });
  assert.equal(result.status, 400);
  assert.match(result.body, /since you entered Review/u);
  assert.deepEqual(silent.applied, []);
  assert.equal((await fixture([{ kind: "mode", mode: "Review" }, { kind: "message", audience: "user" }]).call({ mode: "Implement" })).status, 200);
});

const announced: WorkflowLedgerEntry[] = [{ kind: "mode", mode: "Review" }, { kind: "message", audience: "user" }];

test("a refused process document applies nothing else, and a refused mode never touches the list", async () => {
  const refused = fixture(announced, { admitFails: true });
  const result = await refused.call({ processDocuments: ["tracked.md"], mode: "Implement", title: "New", status: "blocked" });
  assert.equal(result.status, 400);
  assert.match(result.body, /Tracked files/u);
  assert.deepEqual(refused.applied, []);
  const gated = fixture();
  assert.equal((await gated.call({ processDocuments: ["notes.md"], mode: "Fixing" })).status, 400);
  assert.deepEqual(gated.applied, []);
});

test("a mode switch backs up the list this call leaves in place; other calls never back up", async () => {
  const replaced = fixture(announced, { listed: ["old.md"] });
  const result = await replaced.call({ processDocuments: ["new.md"], mode: "Implement" });
  assert.equal(result.status, 200);
  assert.deepEqual(replaced.applied, ["admit:new.md", "backup:new.md"]);
  assert.match(result.body, /Process documents: new\.md\./u);
  assert.match(result.body, /backed up/u);
  const kept = fixture(announced, { listed: ["old.md"] });
  await kept.call({ mode: "Implement" });
  assert.deepEqual(kept.applied, ["backup:old.md"]);
  const titled = fixture(announced, { listed: ["old.md"] });
  await titled.call({ title: "New" });
  assert.deepEqual(titled.applied, ["title:New"]);
  const empty = fixture(announced);
  await empty.call({ mode: "Implement" });
  assert.deepEqual(empty.applied, []);
});

test("an unchanged backup stays quiet and a failed one is reported without holding up the mode", async () => {
  const unchanged = await fixture(announced, { listed: ["notes.md"], backedUp: false }).call({ mode: "Implement" });
  assert.doesNotMatch(unchanged.body, /backed up|backup/u);
  const failed = await fixture(announced, { listed: ["notes.md"], backupFails: true }).call({ mode: "Implement" });
  assert.equal(failed.status, 200);
  assert.match(failed.body, /Entered Implement/u);
  assert.match(failed.body, /backup failed: disk full/u);
});

test("invalid proofs are rejected before anything runs", async () => {
  const { applied, call } = fixture();
  assert.equal((await call({ proofs: { "review.coverage": "ok" }, notApplicable: ["review.coverage"], status: "blocked" })).status, 400);
  assert.deepEqual(applied, []);
});
