/*
 * Exports:
 * - No production exports; tests protect daemon-backed file read/save identity and mtime flow. Keywords: workbench, file, daemon, mtime, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import FileDraftStore from "./state/FileDraftStore.ts";
import FileSessionState from "./state/FileSessionState.ts";
import SessionState from "./state/SessionState.ts";
import WorkbenchEventBus from "./WorkbenchEventBus.ts";
import WorkbenchFileClient from "./WorkbenchFileClient.ts";

test("file lifecycle uses the daemon transport and carries the opened mtime into save", async () => {
  let renderedContent = "";
  const calls: unknown[] = [];
  const fileSessionState = FileSessionState();
  const sessionState = SessionState();
  const client = WorkbenchFileClient({
    clearThreadSelection: () => undefined,
    draftStore: FileDraftStore(() => "project"),
    editorDocument: {
      appendMarkdownFragment: () => undefined,
      captureSelection: () => null,
      inspectDraft: () => ({ content: renderedContent, issue: null }),
      inspectRichDocument: () => ({ markdown: renderedContent, issue: null }),
      isFocused: () => false,
      logBlockedSaveIssue: () => undefined,
      readRenderedState: () => renderedContent,
      refreshStatusMessage: () => undefined,
      renderDocument: (content) => { renderedContent = content; },
      restoreSelection: () => undefined,
      scheduleDiffGutterRefresh: () => undefined,
      setEditable: () => undefined,
    },
    emitExplorerStateChange: () => undefined,
    eventBus: WorkbenchEventBus(),
    expandProjectPath: () => undefined,
    fileSessionState,
    fileTransport: {
      read: async (projectId, path) => {
        calls.push(["read", projectId, path]);
        return {
          content: "before",
          headContent: "head",
          mtimeMs: 10,
          path,
          projectId,
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      },
      reset: async () => { throw new Error("reset was not requested"); },
      save: async (projectId, path, content, expectedMtimeMs, force) => {
        calls.push(["save", projectId, path, content, expectedMtimeMs, force]);
        return {
          changes: {},
          mtimeMs: 20,
          path,
          projectId,
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
      },
    },
    getProjectId: () => "project",
    refreshProject: async () => undefined,
    sessionState,
    updateHistorySelection: () => undefined,
  });
  try {
    assert.equal(await client.openFile("note.md"), true);
    renderedContent = "after";
    await client.saveCurrentFile();
    assert.deepEqual(calls, [
      ["read", "project", "note.md"],
      ["save", "project", "note.md", "after", 10, false],
    ]);
    assert.equal(fileSessionState.expectedMtimeMs, 20);
    assert.equal(fileSessionState.dirty, false);
  } finally {
    client.dispose();
  }
});
