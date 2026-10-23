/* No production exports. Tests protect counting transcript windows in visible rows rather than raw items. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { selectNewestTranscriptRows } from "./transcript-row-credit.ts";

const run = (length: number) => Array.from({ length }, (_, index) => index % 3 ? "operation" : "reasoning");

test("a stretch of agent work counts as one row however long, standalone items one each", () => {
  const types = ["userMessage", ...run(700), "assistantMessage", "userMessage", ...run(5), "assistantMessage"];
  assert.equal(selectNewestTranscriptRows(types, 1), types.length - 1);
  assert.equal(selectNewestTranscriptRows(types, 2), types.length - 6, "the newest run is one row");
  assert.equal(selectNewestTranscriptRows(types, 5), 1, "the 700-item run is one row, taken whole");
  assert.equal(selectNewestTranscriptRows(types, 6), 0);
  assert.equal(selectNewestTranscriptRows(types, 50), 0);
});

test("standalone items between runs split them into separate rows", () => {
  const types = [...run(3), "questionnaire", ...run(4), "approval", ...run(2)];
  assert.equal(selectNewestTranscriptRows(types, 1), types.length - 2);
  assert.equal(selectNewestTranscriptRows(types, 3), types.length - 7);
  assert.equal(selectNewestTranscriptRows(types, 4), 3);
});
