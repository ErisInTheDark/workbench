/*
 * No production exports. Protect draft recovery, conflict-guarded saves, history coalescing and clean-only refreshes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import TextFileDocumentController, { type TextFileDocumentPort } from "./TextFileDocumentController";

function harness({ disk = "<svg/>", mtimeMs = 1, draft = null as { content: string; mtimeMs: number | null } | null } = {}) {
  const file = { content: disk, mtimeMs };
  const saves: Array<{ content: string; expectedMtimeMs: number; force: boolean }> = [];
  const drafts: { stored: { content: string; mtimeMs: number | null } | null; writes: number } = { stored: draft, writes: 0 };
  let clock = 0;
  const port: TextFileDocumentPort = {
    read: async () => ({ ...file }),
    save: async (content, expectedMtimeMs, force) => {
      saves.push({ content, expectedMtimeMs, force });
      if (!force && expectedMtimeMs !== file.mtimeMs) return { kind: "conflict", message: "changed on disk" };
      file.content = content;
      file.mtimeMs += 1;
      return { kind: "saved", mtimeMs: file.mtimeMs };
    },
    drafts: {
      read: () => drafts.stored,
      write: ({ content, mtimeMs }) => { drafts.stored = { content, mtimeMs }; drafts.writes += 1; },
      clear: async () => { drafts.stored = null; },
    },
  };
  const controller = new TextFileDocumentController(port, () => clock);
  return { controller, drafts, file, saves, tick: (ms: number) => { clock += ms; } };
}

test("a stored draft reopens dirty and keeps saves guarded by the disk version it was based on", async () => {
  const h = harness({ disk: "<svg>new</svg>", mtimeMs: 5, draft: { content: "<svg>mine</svg>", mtimeMs: 3 } });
  await h.controller.load();
  assert.equal(h.controller.getSnapshot().content, "<svg>mine</svg>");
  assert.equal(h.controller.getSnapshot().dirty, true);
  await h.controller.save();
  assert.equal(h.controller.getSnapshot().conflict, "changed on disk");
  assert.equal(h.file.content, "<svg>new</svg>");
  await h.controller.save({ force: true });
  assert.equal(h.file.content, "<svg>mine</svg>");
  assert.equal(h.controller.getSnapshot().dirty, false);
  assert.equal(h.controller.getSnapshot().conflict, null);
  assert.equal(h.drafts.stored, null);
});

test("typing coalesces within its window, undo never merges into the entry it returns to", async () => {
  const h = harness();
  await h.controller.load();
  const typing = { coalesce: { key: "typing", windowMs: 1000 } };
  h.controller.edit("<svg>a", typing);
  h.tick(100);
  h.controller.edit("<svg>ab", typing);
  h.tick(2000);
  h.controller.edit("<svg>abc", typing);
  h.controller.undo();
  assert.equal(h.controller.getSnapshot().content, "<svg>ab");
  h.controller.edit("<svg>abX", typing);
  h.controller.undo();
  assert.equal(h.controller.getSnapshot().content, "<svg>ab");
  h.controller.undo();
  assert.equal(h.controller.getSnapshot().content, "<svg/>");
  assert.equal(h.controller.getSnapshot().canUndo, false);
  h.controller.redo();
  assert.equal(h.controller.getSnapshot().content, "<svg>ab");
});

test("a drag is one undo step and persists its draft only once it settles", async () => {
  const h = harness();
  await h.controller.load();
  const drag = { coalesce: { key: "drag:1" }, transient: true };
  h.controller.edit("<svg a/>", drag);
  h.tick(5000);
  h.controller.edit("<svg ab/>", drag);
  assert.equal(h.drafts.writes, 0);
  h.controller.persistDraft();
  assert.deepEqual(h.drafts.stored, { content: "<svg ab/>", mtimeMs: 1 });
  h.controller.undo();
  assert.equal(h.controller.getSnapshot().content, "<svg/>");
  assert.equal(h.drafts.stored, null);
});

test("revert is undoable and clean refreshes follow disk without overwriting local edits", async () => {
  const h = harness();
  await h.controller.load();
  h.controller.edit("<svg>edit</svg>");
  h.controller.revert();
  assert.equal(h.controller.getSnapshot().dirty, false);
  h.controller.undo();
  assert.equal(h.controller.getSnapshot().content, "<svg>edit</svg>");
  Object.assign(h.file, { content: "<svg>outside</svg>", mtimeMs: 9 });
  await h.controller.refreshIfClean();
  assert.equal(h.controller.getSnapshot().content, "<svg>edit</svg>");
  h.controller.revert();
  await h.controller.refreshIfClean();
  assert.equal(h.controller.getSnapshot().content, "<svg>outside</svg>");
  assert.equal(h.controller.getSnapshot().dirty, false);
  h.controller.edit("<svg>after</svg>");
  await h.controller.save();
  assert.equal(h.saves.at(-1)?.expectedMtimeMs, 9);
  assert.equal(h.file.content, "<svg>after</svg>");
});
