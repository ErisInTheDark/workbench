/*
 * No production exports. Tests protect staged instruction reads, rollback, and active-generation observation. Keywords: reload, instructions, source, generation, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beginReloadSourceGeneration,
  cancelReloadSourceGeneration,
  completeReloadSourceGeneration,
  observeReloadInstructionSource,
  setActiveReloadInstructionObserver,
} from "./reload-source-observer";

test("instruction reads publish only from the generation that completes", () => {
  const active: string[] = [];
  const clear = setActiveReloadInstructionObserver((sourcePath) => active.push(sourcePath));
  try {
    const failed = beginReloadSourceGeneration();
    observeReloadInstructionSource("C:/workspace/failed.md");
    cancelReloadSourceGeneration(failed);
    assert.deepEqual(active, []);

    const successful = beginReloadSourceGeneration();
    observeReloadInstructionSource("C:/workspace/b.md");
    observeReloadInstructionSource("C:/workspace/a.md");
    observeReloadInstructionSource("C:/workspace/a.md");
    assert.deepEqual(completeReloadSourceGeneration(successful), ["C:/workspace/a.md", "C:/workspace/b.md"]);
    assert.deepEqual(active, []);

    observeReloadInstructionSource("C:/workspace/later.md");
    assert.deepEqual(active, ["C:/workspace/later.md"]);
  } finally {
    clear();
  }
});

test("a superseded source generation cannot publish another generation's reads", () => {
  const first = beginReloadSourceGeneration();
  const second = beginReloadSourceGeneration();
  assert.throws(() => completeReloadSourceGeneration(first), /ownership changed/u);
  cancelReloadSourceGeneration(second);
});
