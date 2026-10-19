/* No exports. Protect observed file updates, draft recovery, in-flight edit preservation and unsaved new files. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { SaveFilePayload } from "workbench-shared/types";
import type { ProjectFileSnapshot } from "workbench-shared/workbench/project/project-file";
import type { WorkbenchFileDocument } from "./file/WorkbenchFileStore";
import FileDraftStore from "./state/FileDraftStore.ts";
import FileSessionState from "./state/FileSessionState.ts";
import SessionState from "./state/SessionState.ts";
import WorkbenchEventBus from "./WorkbenchEventBus.ts";
import WorkbenchFileClient from "./WorkbenchFileClient.ts";

const location = {
  daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  projectId: ProjectIdSchema.parse("project"),
};
const disk = (content = "before", mtimeMs = 10): ProjectFileSnapshot => ({
  content, headContent: "head", mtimeMs, path: "note.md", projectId: location.projectId,
  updatedAt: new Date(mtimeMs).toISOString(), changeSummary: null,
});
const saved = (mtimeMs: number): SaveFilePayload => ({
  changes: {}, mtimeMs, path: "note.md", projectId: location.projectId, updatedAt: new Date(mtimeMs).toISOString(),
});

function fixture(overrides: Partial<WorkbenchFileDocument> = {}) {
  let renderedContent = "";
  const calls: Array<{ content: string; mtime: number }> = [];
  const fileSessionState = FileSessionState();
  const sessionState = SessionState();
  const drafts = overrides.drafts ?? FileDraftStore(() => location.projectId);
  const document: WorkbenchFileDocument = {
    location, path: "note.md", drafts,
    getSnapshot: () => ({ phase: "current", failure: null, data: disk() }),
    subscribe: () => () => {},
    read: async () => disk(),
    save: async (content, mtime) => { calls.push({ content, mtime }); return saved(20); },
    reset: async () => saved(20),
    ...overrides,
  };
  const client = WorkbenchFileClient({
    document,
    editorDocument: {
      appendMarkdownFragment: content => { renderedContent += content; },
      captureCaretAnchor: () => null,
      captureSelection: () => null,
      inspectDraft: () => ({ content: renderedContent, issue: null }),
      inspectRichDocument: () => ({ markdown: renderedContent, issue: null }),
      isFocused: () => false,
      logBlockedSaveIssue: () => undefined,
      readRenderedState: () => renderedContent,
      refreshStatusMessage: () => undefined,
      renderDocument: (content) => { renderedContent = content; },
      restoreCaretAnchor: () => undefined,
      restoreSelection: () => undefined,
      scheduleDiffGutterRefresh: () => undefined,
      setEditable: () => undefined,
    },
    eventBus: WorkbenchEventBus(),
    fileSessionState,
    recordEditHistory: () => undefined,
    sessionState,
    updateHistorySelection: () => undefined,
  });
  return {
    client, calls, drafts, state: fileSessionState,
    edit: (content: string) => { renderedContent = content; client.syncCurrentDraftBuffer(); },
    read: () => renderedContent,
    receive: (data: ProjectFileSnapshot) => client.acceptObservation({ phase: "current", failure: null, data }),
  };
}

test("observed content opens without a read command and saves with its disk mtime", async context => {
  const f = fixture({ read: async () => { throw new Error("Initial observation must not issue a read."); } });
  context.after(f.client.dispose);
  f.receive(disk());
  assert.equal(f.read(), "before");
  f.edit("after");
  await f.client.saveCurrentFile();
  assert.deepEqual(f.calls, [{ content: "after", mtime: 10 }]);
  assert.equal(f.state.expectedMtimeMs, 20);
  assert.equal(f.state.dirty, false);
});

test("incoming disk changes update clean text but cannot replace a local draft", context => {
  const f = fixture();
  context.after(f.client.dispose);
  f.receive(disk());
  f.receive(disk("replacement", 20));
  assert.equal(f.read(), "replacement");
  f.edit("mine");
  f.receive(disk("external", 30));
  assert.equal(f.read(), "mine");
  assert.equal(f.state.expectedMtimeMs, 20);
  assert.equal(f.state.dirty, true);
});

test("an externally replaced file may have an older mtime without being an older observation", context => {
  const f = fixture();
  context.after(f.client.dispose);
  f.receive(disk("initial", 20));
  f.receive(disk("restored copy", 10));
  assert.equal(f.read(), "restored copy");
  assert.equal(f.state.expectedMtimeMs, 10);
});

test("a successful save acknowledges submitted text without losing newer typing", async context => {
  const pending = Promise.withResolvers<SaveFilePayload>();
  const f = fixture({ save: () => pending.promise });
  context.after(f.client.dispose);
  f.receive(disk());
  f.edit("submitted");
  const saving = f.client.saveCurrentFile();
  f.edit("newer edit");
  f.receive(disk("submitted", 20));
  pending.resolve(saved(20));
  await saving;
  assert.equal(f.read(), "newer edit");
  assert.equal(f.state.baselineContent, "submitted");
  assert.equal(f.state.expectedMtimeMs, 20);
  assert.equal(f.state.dirty, true);
  assert.equal(f.drafts.getBuffer("note.md")?.content, "newer edit");
});

test("a disk value buffered during a save cannot undo its acknowledgement", async context => {
  const pending = Promise.withResolvers<SaveFilePayload>();
  const f = fixture({ save: () => pending.promise });
  context.after(f.client.dispose);
  f.receive(disk());
  f.edit("submitted");
  const saving = f.client.saveCurrentFile();
  f.receive({ ...disk(), headContent: "new HEAD" });
  pending.resolve(saved(20));
  await saving;
  assert.equal(f.read(), "submitted");
  assert.equal(f.state.expectedMtimeMs, 20);
});

test("closing during a save preserves the draft and fences its late acknowledgement", async () => {
  const pending = Promise.withResolvers<SaveFilePayload>();
  const f = fixture({ save: () => pending.promise });
  f.receive(disk());
  f.edit("submitted");
  const saving = f.client.saveCurrentFile();
  f.edit("keep after close");
  f.client.dispose();
  pending.resolve(saved(20));
  await saving;
  assert.equal(f.drafts.getBuffer("note.md")?.content, "keep after close");
  const reopened = fixture({ drafts: f.drafts });
  assert.equal(reopened.read(), "keep after close");
  reopened.receive(disk("submitted", 20));
  assert.equal(reopened.read(), "keep after close");
  reopened.client.dispose();
});

test("conflicts and failed resets retain editable state", async context => {
  const f = fixture({
    save: async () => ({
      actualMtimeMs: 30, actualUpdatedAt: new Date(30).toISOString(),
      expectedMtimeMs: 10, expectedUpdatedAt: new Date(10).toISOString(),
      path: "note.md", error: "changed externally",
    }),
    read: async () => { throw new Error("disconnected"); },
  });
  context.after(f.client.dispose);
  f.receive(disk());
  f.edit("mine");
  await f.client.saveCurrentFile();
  assert.ok(f.state.pendingWriteConflict);
  f.receive(disk("external", 30));
  assert.equal(f.read(), "mine");
  await f.client.resetCurrentDraftToSaved();
  assert.equal(f.read(), "mine");
  assert.ok(f.state.pendingWriteConflict);
});

test("an unsaved new file edits its draft, never saves in place, and follows disk once saved under its name", async context => {
  const drafts = FileDraftStore(() => location.projectId);
  drafts.createNewFileBuffer("note.md", "", "plain");
  const f = fixture({ drafts, getSnapshot: () => ({ phase: "failed", failure: "missing", data: null }) });
  context.after(f.client.dispose);
  assert.equal(f.client.isNewFile(), true);
  f.receive(disk("someone else's", 5));
  assert.equal(f.read(), "", "disk observations never replace a new file's draft");

  f.edit("hello");
  f.edit("");
  assert.equal(f.drafts.getBuffer("note.md")?.expectedMtimeMs, null, "emptied again, the new file is still kept");
  await f.client.saveCurrentFile();
  assert.deepEqual(f.calls, [], "a new file is saved only under a chosen name");

  await f.client.handOffToCopy();
  assert.equal(f.drafts.getBuffer("note.md"), null);
  f.receive(disk("written", 30));
  assert.equal(f.read(), "written");
  assert.equal(f.client.isNewFile(), false);
});

test("a new file's draft that arrives after its editor opens (restored after a reload) is adopted", context => {
  const drafts = FileDraftStore(() => location.projectId);
  const f = fixture({ drafts, getSnapshot: () => ({ phase: "failed", failure: "missing", data: null }) });
  context.after(f.client.dispose);
  assert.equal(f.client.isNewFile(), false);
  drafts.createNewFileBuffer("note.md", "restored", "plain");
  assert.equal(f.client.isNewFile(), true);
  assert.equal(f.read(), "restored");
});

test("a new file's persisted draft adopted silently by the store opens on the next observation", context => {
  const store = FileDraftStore(() => location.projectId);
  store.createNewFileBuffer("note.md", "restored", "plain");
  let arrived = false;
  const drafts = { ...store, getBuffer: (path: string) => arrived ? store.getBuffer(path) : null, subscribe: () => () => {} };
  const f = fixture({ drafts });
  context.after(f.client.dispose);
  arrived = true;
  f.client.acceptObservation({ phase: "failed", failure: "missing", data: null });
  assert.equal(f.client.isNewFile(), true);
  assert.equal(f.read(), "restored");
});

test("a new file discarded elsewhere is not written back when its editor closes", () => {
  const drafts = FileDraftStore(() => location.projectId);
  drafts.createNewFileBuffer("note.md", "draft", "plain");
  const f = fixture({ drafts });
  void drafts.clearBuffer("note.md");
  f.client.dispose();
  assert.equal(drafts.getBuffer("note.md"), null);
});

test("a reload finishing after more typing does not replace that edit", async context => {
  const pending = Promise.withResolvers<ProjectFileSnapshot>();
  const f = fixture({ read: () => pending.promise });
  context.after(f.client.dispose);
  f.receive(disk());
  f.edit("discard this");
  const resetting = f.client.resetCurrentDraftToSaved();
  f.edit("keep this");
  pending.resolve(disk("disk", 20));
  await resetting;
  assert.equal(f.read(), "keep this");
  assert.equal(f.drafts.getBuffer("note.md")?.content, "keep this");
});
