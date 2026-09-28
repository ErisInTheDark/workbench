/* No production exports. Protect pushed state freshness, mutation failures and same-tab draft deletion receipts. */
import assert from "node:assert/strict";
import test from "node:test";
import type { PresentationDraftInput, PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import { DaemonIdSchema, DraftIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { createWorkspaceClientFixture } from "../app/workspace-client-fixture";
import WorkbenchPresentationClient from "./WorkbenchPresentationClient";

const draft: PresentationDraftInput = {
  id: DraftIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  logicalProjectId: LogicalProjectIdSchema.parse("00000000-0000-4000-8000-000000000002"),
  target: { daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000003"),
    projectId: ProjectIdSchema.parse("local-folder") },
  prompt: "saved words", updatedAt: 1,
  selection: { kind: "custom", settings: { harness: "codex", model: "",
    agentPath: null, agentSource: null, reasoningEffort: null, serviceTier: null } },
};
function snapshot(revision: number, includeDraft = false): PresentationSnapshot {
  return { daemons: [], defaults: [], divergences: [], drafts: includeDraft ? [{
    ...draft, revision: 5, phase: "unsent", pinned: false, snoozed: false,
    launchId: null, acceptedThreadId: null, attachments: [],
  }] : [], folders: [], locations: [], members: [], projects: [], revision, sourceMappings: [] };
}

test("presentation readiness joins one pushed query and disposal releases pending readers", async context => {
  const fixture = createWorkspaceClientFixture();
  const client = new WorkbenchPresentationClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const socket = await fixture.open();
  const first = client.ready();
  const second = client.ready();
  const query = await socket.request("workspace/observe", 0, request => request.params.query.kind === "presentation");
  socket.observation(query, { kind: "presentation", phase: "current", failure: null, data: snapshot(1) });
  assert.equal(await first, await second);
  assert.equal(socket.sent.filter(request => request.method === "workspace/observe").length, 1);

  const other = createWorkspaceClientFixture();
  const pending = new WorkbenchPresentationClient({ workspace: other.workspace });
  context.after(() => { pending.dispose(); other.dispose(); });
  const waiting = pending.ready();
  pending.dispose();
  await assert.rejects(waiting, /closed/);
});

test("pushed facts do not refetch and a delayed write response cannot regress them", async context => {
  const fixture = createWorkspaceClientFixture();
  const client = new WorkbenchPresentationClient({ workspace: fixture.workspace,
    fetcher: async () => { throw new Error("Unexpected HTTP state read"); } });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const socket = await fixture.open();
  client.start();
  const query = await socket.request("workspace/observe");
  socket.observation(query, { kind: "presentation", phase: "current", failure: null, data: snapshot(1) });
  const write = client.putDraft(draft);
  const request = await socket.request("app/presentation/mutate");
  socket.observation(query, { kind: "presentation", phase: "current", failure: null, data: snapshot(3, true) }, 2);
  socket.reply(request, snapshot(2, true));
  await write;
  assert.equal(client.snapshot().data?.revision, 3);
  assert.equal(socket.sent.filter(item => item.method === "workspace/observe").length, 1);
});

test("own delete receipt remains exact when a newer publication overtakes its acknowledgement", async context => {
  const fixture = createWorkspaceClientFixture();
  const client = new WorkbenchPresentationClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const socket = await fixture.open();
  client.start();
  const query = await socket.request("workspace/observe");
  socket.observation(query, { kind: "presentation", phase: "current", failure: null, data: snapshot(40, true) });
  const removing = client.removeDraft(draft.id);
  const removal = await socket.request("app/presentation/mutate");
  socket.observation(query, { kind: "presentation", phase: "current", failure: null, data: snapshot(43) }, 2);
  socket.reply(removal, snapshot(42));
  await removing;
  const offset = socket.sent.length;
  const writing = client.putDraft({ ...draft, prompt: "new words" });
  const reopen = await socket.request("app/presentation/mutate", offset);
  assert.equal(reopen.params.mutation.kind, "putDraft");
  assert.equal(reopen.params.mutation.expectedRevision, 42);
  socket.reply(reopen, snapshot(44, true));
  await writing;
});

test("another client's deletion grants no reopen token and conflicting edits remain failed without retry", async context => {
  const fixture = createWorkspaceClientFixture();
  const client = new WorkbenchPresentationClient({ workspace: fixture.workspace });
  context.after(() => { client.dispose(); fixture.dispose(); });
  const socket = await fixture.open();
  client.start();
  const query = await socket.request("workspace/observe");
  socket.observation(query, { kind: "presentation", phase: "current", failure: null, data: snapshot(10, true) });
  socket.observation(query, { kind: "presentation", phase: "current", failure: null, data: snapshot(12) }, 2);
  const write = client.putDraft(draft);
  const failed = assert.rejects(write, /another browser/);
  const mutation = await socket.request("app/presentation/mutate");
  assert.equal(mutation.params.mutation.expectedRevision, null);
  socket.fail(mutation, "Draft changed in another browser.");
  await failed;
  assert.equal(client.snapshot().phase, "failed");
  assert.equal(socket.sent.filter(item => item.method === "app/presentation/mutate").length, 1);
  assert.equal(socket.sent.filter(item => item.method === "workspace/observe").length, 1);
});
