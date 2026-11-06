/*
 * No production exports. Tests pinned instruction layers over current files, and mode denials: claimed edits vs gitignored ones,
 * process document exemptions, tool and arc worktree denials, the pre-mode and compaction locks, the first declared mode standing in
 * for an undeclared one, and that thread_state is never denied.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import type { WorkflowLedgerEntry, WorkflowMode } from "workbench-shared/workbench/thread/workflow-modes";
import type { StoredThreadInstructionOverlays } from "../database/thread-state/WorkbenchThreadInstructionOverlayStore";
import WorkbenchThreadInstructionPins from "./WorkbenchThreadInstructionPins";
import WorkbenchThreadWorkflowReader from "./WorkbenchThreadWorkflowReader";

const root = path.resolve("project");
const review: WorkflowMode = { name: "Review", icon: "flag", color: null, proofs: [], resetOn: [], from: [], after: null, status: null, deny: ["shell", "edit:claims"] };
const locked: WorkflowMode = { ...review, name: "Locked", deny: ["edit"] };
const nothingPinned = { base: null, skills: new Map() };

function reader(ledger: WorkflowLedgerEntry[], modes: WorkflowMode[] = [review, locked], checklists: ProofOfWorkChecklist[] = []) {
  return new WorkbenchThreadWorkflowReader({
    readSelection: async () => ({ workflowIds: ["default"] }),
    readSkills: async () => [],
    readProjectRoot: async () => root,
    readLedger: async () => ledger,
    readPins: async () => nothingPinned,
    readBaseLayers: async () => [{ checklists, modes }],
    readSkillLayers: async () => [],
  });
}

/** A thread pinned through the real pin owner over an in-memory store, beside "current files" the test can change. */
function pinned(skillPaths: string[]) {
  const layer = (...names: string[]) => ({ checklists: [], modes: names.map(name => ({ ...review, name, deny: [] })) });
  const files = { base: layer("Inspect"), skills: new Map<string, ReturnType<typeof layer>>() };
  let stored: StoredThreadInstructionOverlays | null = null;
  const pins = new WorkbenchThreadInstructionPins({
    execute: async command => {
      if (command.kind === "read") return stored;
      if (command.kind === "pinBase") stored = { base: structuredClone(command.layers), skills: stored?.skills ?? {}, prefix: null };
      if (command.kind === "pinSkills") {
        stored = { base: stored?.base ?? null, skills: { ...stored?.skills, ...structuredClone(command.skills) }, prefix: null };
      }
      return null;
    },
    readToolFingerprint: async () => "tools",
    rebuildPrefixHash: async () => "hash",
  });
  const workflow = new WorkbenchThreadWorkflowReader({
    readSelection: async () => ({ workflowIds: ["default"] }),
    readSkills: async () => skillPaths.map((skillPath, index) => ({ path: skillPath, name: `skill${index}`, source: "user" as const, activatedAt: index })),
    readProjectRoot: async () => root,
    readLedger: async () => [],
    readPins: threadId => pins.read(threadId),
    readBaseLayers: async () => [files.base],
    readSkillLayers: async (_root, paths) => (paths ?? []).flatMap(skillPath => {
      const found = files.skills.get(skillPath);
      return found ? [{ path: skillPath, layer: found }] : [];
    }),
  });
  const modes = async () => (await workflow.read("t")).overlays.modes.map(mode => mode.name);
  return { files, layer, modes, pins, corrupt: () => { stored = { base: [{ modes: "broken" }], skills: {}, prefix: null }; } };
}

test("gates follow the pinned base until the next build pins again; never-pinned threads and unreadable pins use current files", async () => {
  const thread = pinned([]);
  assert.deepEqual(await thread.modes(), ["Inspect"], "nothing pinned yet");
  await thread.pins.pin("t", { base: [thread.layer("Brief")], prefix: null });
  thread.files.base = thread.layer("Edited");
  assert.deepEqual(await thread.modes(), ["Brief"], "a mid-turn edit does not reach the turn");
  await thread.pins.pin("t", { base: [thread.layer("Edited")], prefix: null });
  assert.deepEqual(await thread.modes(), ["Edited"], "the next build delivers it");
  thread.corrupt();
  assert.deepEqual(await thread.modes(), ["Edited"], "a stored shape this daemon cannot read falls back to current files");
});

test("active skills layer over the base in activation order, each from its pin or else its current file", async () => {
  const first = path.join(root, "skills/first/SKILL.md");
  const second = path.join(root, "skills/second/SKILL.md");
  const thread = pinned([first, second]);
  thread.files.skills.set(first, thread.layer("FirstLive"));
  thread.files.skills.set(second, thread.layer("SecondLive"));
  await thread.pins.pin("t", { skills: [{ path: first, layer: thread.layer("FirstPinned") }] });
  assert.deepEqual(await thread.modes(), ["Inspect", "FirstPinned", "SecondLive"]);
});

const claimed = path.join(root, "src/a.ts");
const ignored = path.join(root, ".workbench/notes.md");
const notes = path.join(root, "docs/plan.md");

test("edit:claims denies claimed Git-visible edits but not gitignored ones or process documents", async () => {
  const workflow = reader([{ kind: "processDocuments", paths: ["docs/plan.md"] }, { kind: "mode", mode: "Review" }]);
  const denial = await workflow.readEditDenial("t", [claimed, ignored, notes], [claimed, notes]);
  assert.equal([claimed, ignored, notes].map(candidate => denial?.includes(candidate)).join(), "true,false,false");
  assert.equal(await workflow.readEditDenial("t", [ignored, notes], [notes]), null);
});

test("edit denies gitignored edits too", async () => {
  assert.notEqual(await reader([{ kind: "mode", mode: "Locked" }]).readEditDenial("t", [ignored], []), null);
});

test("before a first mode only state, recall and messaging tools run and nothing is edited; mode-free workflows deny nothing", async () => {
  const fresh = reader([{ kind: "message", audience: "user" }], [{ ...review, deny: [] }]);
  for (const tool of ["thread_state", "thread_recall", "thread_recall_search", "message_user", "message_agent"]) {
    assert.equal(await fresh.readToolDenial("t", tool), null, tool);
  }
  for (const tool of ["shell", "rg", "read", "skill"]) assert.notEqual(await fresh.readToolDenial("t", tool), null, tool);
  assert.notEqual(await fresh.readEditDenial("t", [notes], []), null, "process document or unclaimed, nothing is edited");
  assert.equal(await reader([], []).readEditDenial("t", [claimed], [claimed]), null);
  assert.equal(await reader([], []).readToolDenial("t", "shell"), null);
});

test("an undeclared current mode applies the first declared mode", async () => {
  assert.notEqual(await reader([{ kind: "mode", mode: "Decision" }]).readToolDenial("t", "shell"), null);
});

test("an unrecovered compaction denies every edit and worktree tool until a recall and its checklist follow it", async () => {
  const open: WorkflowMode = { ...review, name: "Open", deny: [] };
  const checklist = { id: "compaction", hidden: false, items: [{ id: "compaction.narrative", label: "Narrative" }] };
  const compacted = (...after: WorkflowLedgerEntry[]) => reader(
    [{ kind: "processDocuments", paths: ["docs/plan.md"] }, { kind: "mode", mode: "Open" }, { kind: "compaction" }, ...after], [open], [checklist],
  );
  assert.notEqual(await compacted().readEditDenial("t", [notes], []), null, "process documents are locked too");
  assert.notEqual(await compacted({ kind: "recall" }).readToolDenial("t", "git_arc_restore"), null, "the checklist is still owed");
  assert.notEqual(await compacted({ kind: "recall" }).readToolDenial("t", "git_arc_restore", { ref: "process-documents" }), null, "so is a backup restore");
  assert.equal(await compacted().readToolDenial("t", "shell"), null, "inspection stays open");
  const recovered = compacted({ kind: "recall" }, { kind: "proof", proof: { proofs: { "compaction.narrative": "request, plan" } } });
  assert.equal(await recovered.readEditDenial("t", [claimed], [claimed]), null);
  assert.equal(await recovered.readToolDenial("t", "git_arc_restore"), null);
});

test("a mode denies its listed tools and, with edit denials, arc tools that write the worktree; never thread_state", async () => {
  const workflow = reader([{ kind: "mode", mode: "review" }]);
  assert.notEqual(await workflow.readToolDenial("t", "shell"), null);
  for (const tool of ["git_arc_restore", "git_arc_stash", "git_arc_unstash", "git_arc_edit_apply"]) {
    assert.notEqual(await workflow.readToolDenial("t", tool), null, tool);
  }
  assert.equal(await workflow.readToolDenial("t", "git_arc_restore", { ref: "process-documents" }), null, "backups restore in any mode");
  assert.equal(await workflow.readToolDenial("t", "git_arc_restore", { ref: "process-documents~2" }), null);
  assert.notEqual(await workflow.readToolDenial("t", "git_arc_restore", { ref: "abcdef1" }), null, "arc refs stay denied");
  assert.notEqual(await workflow.readToolDenial("t", "git_arc_stash", { ref: "process-documents" }), null, "only restore reads the ref");
  assert.equal(await workflow.readToolDenial("t", "git_arc_adopt"), null);
  assert.equal(await workflow.readToolDenial("t", "rg"), null);
  assert.equal(await workflow.readToolDenial("t", "thread_state"), null);
  const open = reader([{ kind: "mode", mode: "Open" }], [{ ...review, name: "Open", deny: ["read"] }]);
  assert.equal(await open.readToolDenial("t", "git_arc_restore"), null, "worktree tools follow edit denials only");
  assert.notEqual(await open.readToolDenial("t", "read"), null);
});
