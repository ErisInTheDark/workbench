/* No exports. Protect file observation demand, folder identity and command isolation. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { createWorkspaceClientFixture } from "../app/workspace-client-fixture";
import WorkbenchFileStore from "./WorkbenchFileStore";

test("file consumers share a lease and identical paths on different daemons stay independent", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const store = new WorkbenchFileStore(fixture.workspace, undefined, () => "", message => assert.fail(message));
  context.after(() => { store.dispose(); fixture.dispose(); });
  const location = {
    daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001"),
    projectId: ProjectIdSchema.parse("project"),
  };
  const first = store.document(location, "notes.md");
  const second = store.document({ ...location }, "notes.md");
  const remote = store.document({ ...location,
    daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002") }, "notes.md");
  assert.equal(first, second);
  assert.notEqual(first.drafts, remote.drafts);
  const changed = () => {};
  const stopFirst = first.subscribe(changed);
  const stopSecond = second.subscribe(changed);
  const stopRemote = remote.subscribe(() => {});
  const read = await socket.request("workspace/observe", 0, request =>
    request.params.query.kind === "projectFile" && request.params.query.location.daemonId === location.daemonId);
  await socket.observation(read, {
    kind: "projectFile", phase: "current", failure: null,
    data: { projectId: location.projectId, path: "notes.md", content: "local", headContent: null,
      mtimeMs: 1, updatedAt: new Date(1).toISOString(), changeSummary: null },
  });
  assert.equal(first.getSnapshot().data?.content, "local");
  assert.equal(remote.getSnapshot().data, null);
  assert.equal(socket.sent.filter(request => request.method === "workspace/observe"
    && request.params.query.kind === "projectFile").length, 2);
  stopFirst();
  assert.equal(socket.sent.some(request => request.method === "workspace/release"
    && request.params.subscriptionId === read.params.subscriptionId), false);
  stopSecond();
  const released = await socket.request("workspace/release", 0,
    request => request.params.subscriptionId === read.params.subscriptionId);
  socket.reply(released, { ok: true });
  stopRemote();
});

test("file writes use the document's folder without selecting or refreshing the sidebar", async context => {
  const fixture = createWorkspaceClientFixture();
  const socket = await fixture.open();
  const store = new WorkbenchFileStore(fixture.workspace, undefined, () => "", message => assert.fail(message));
  context.after(() => { store.dispose(); fixture.dispose(); });
  const location = {
    daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001"),
    projectId: ProjectIdSchema.parse("remote-folder"),
  };
  const document = store.document(location, "notes.md");
  const saving = document.save("edited", 5);
  const request = await socket.request("workspace/command");
  assert.deepEqual(request.params.scope, { kind: "folder", location });
  assert.equal(request.params.method, "project/file/save");
  socket.reply(request, { changes: {}, projectId: location.projectId, path: "notes.md",
    mtimeMs: 6, updatedAt: new Date(6).toISOString() });
  await saving;
  assert.equal(socket.sent.some(item => item.method === "workspace/observe"
    && (item.params.query.kind === "projectSelection" || item.params.query.kind === "projectTree")), false);
});
