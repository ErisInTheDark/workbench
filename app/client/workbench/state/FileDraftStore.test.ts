/*
 * No production exports. Protect draft recovery when app state arrives after the store, without resurrecting drafts cleared this session.
 */
import assert from "node:assert/strict";
import test from "node:test";

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
