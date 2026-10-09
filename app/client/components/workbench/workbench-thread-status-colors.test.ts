/*
 * No production exports. Tests protect phase-aware attention tones.
 */
import assert from "node:assert/strict";
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
