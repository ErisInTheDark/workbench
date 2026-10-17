/*
 * No production exports. Protect draft and undo-history recovery when app state arrives after the store, without resurrecting drafts cleared this session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import FileDraftStore from "./FileDraftStore";
import WorkbenchClientStateController from "./WorkbenchClientStateController";

const draft = (path: string, content: string) => ({
  daemonRegistrationId: "memory", kind: "fileDraft" as const, projectId: "alpha", path,
  value: { baselineContent: "<svg/>", content, expectedMtimeMs: 7, headContent: null, mode: "plain" as const },
});

test("drafts persisted before a refresh are recovered even when app state loads after the store hydrates", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const store = FileDraftStore(() => "alpha", undefined, state);
  await store.hydratePersistedDrafts();
  assert.equal(store.getBuffer("icon.svg"), null);

  await state.put(draft("icon.svg", "<svg><path/></svg>"));
  await state.put(draft("other.svg", "<svg><g/></svg>"));
  assert.equal(store.getBuffer("icon.svg")?.content, "<svg><path/></svg>");
  assert.equal(store.getBuffer("icon.svg")?.expectedMtimeMs, 7);
  assert.deepEqual(store.getLocallyModifiedPaths(), ["icon.svg", "other.svg"]);

  await store.clearBuffer("other.svg");
  await state.put(draft("other.svg", "<svg><g/></svg>"));
  assert.equal(store.getBuffer("other.svg"), null, "a draft cleared this session stays cleared");
});

test("undo history persists with its draft and restores without stored cursor positions", async () => {
  const state = new WorkbenchClientStateController({ mode: "memory" });
  const writer = FileDraftStore(() => "alpha", undefined, state);
  const selection = { start: { offset: 2, path: [0] }, end: { offset: 2, path: [0] } };
  const history = { currentIndex: 1, selection, frames: [
    { type: "snapshot" as const, content: "<svg/>", timestamp: 1 },
    { type: "patch" as const, patch: { start: 4, deletedText: "/", insertedText: "><g/></svg" }, before: selection,
      after: selection, timestamp: 2 },
  ] };
  writer.setBuffer("icon.svg", {
    baselineContent: "<svg/>", content: "<svg><g/></svg>", dirty: true, editorState: "<svg><g/></svg>",
    expectedMtimeMs: 7, headContent: null, history, mode: "plain", pendingWriteConflict: null, saveIssue: null,
  });
  // Memory-mode persistence settles on microtasks; one immediate turn drains the draft write queue.
  await setImmediate();

  const reader = FileDraftStore(() => "alpha", undefined, state);
  assert.deepEqual(reader.getBuffer("icon.svg")?.history, {
    currentIndex: 1, selection: null, frames: history.frames.map(frame => ({ ...frame, after: null, before: null })),
  });

  await state.put({ ...draft("stale.svg", "<svg>now</svg>"), value: { ...draft("stale.svg", "<svg>now</svg>").value,
    history: { currentIndex: 0, frames: [{ kind: "snapshot", content: "<svg>other</svg>", timestamp: 1 }] } } });
  const [restarted, ...rest] = reader.getBuffer("stale.svg")?.history.frames ?? [];
  assert.deepEqual(rest, [], "history for other content restarts at the draft");
  assert.equal(restarted?.type === "snapshot" ? restarted.content : null, "<svg>now</svg>");
});
