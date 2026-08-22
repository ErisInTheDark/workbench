/*
 * Exports:
 * - No production exports; regression checks protect phase-aware attention colors and shared palette ownership. Keywords: thread, status, color, git, arc, test.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  getNeedsAttentionThreadStatusTone,
} from "./workbench-thread-status-colors";

test("needs-attention tones distinguish active Git arcs from every other phase", () => {
  const activeTone = getNeedsAttentionThreadStatusTone(true);
  const inactiveTone = getNeedsAttentionThreadStatusTone(false);

  assert.equal(activeTone, "needs-attention-active");
  assert.equal(inactiveTone, "needs-attention");
});

test("needs-attention consumers source colors from the shared thread-status palette", async () => {
  const sources = await Promise.all([
    readFile(new URL("./WorkbenchThreadListItem.tsx", import.meta.url), "utf8"),
    readFile(new URL("./WorkbenchContextMenuSurface.tsx", import.meta.url), "utf8"),
    readFile(new URL("./thread-view/ThreadStatusCommandItem.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(sources[0], /getWorkbenchThreadStatusClassName/u);
  assert.match(sources[1], /getWorkbenchThreadStatusControlClassName/u);
  assert.match(sources[2], /getWorkbenchThreadStatusClassName/u);
});
