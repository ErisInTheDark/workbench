/*
 * No production exports. Regression wards protect commentary copy-run merging and section-break splitting.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildThreadCommentaryRuns } from "./thread-commentary-runs";

const plan = "<plan>\nsecret plan\n</plan>";
const mode = "<set-state mode=\"Brief\" />";

test("consecutive commentary prose merges into one run ending at the last item", () => {
  assert.deepEqual(buildThreadCommentaryRuns(["first", "second\n\nmore"]), [
    { breakCopyMarkdown: [], endCopyMarkdown: null },
    { breakCopyMarkdown: [], endCopyMarkdown: "first\n\nsecond\n\nmore" },
  ]);
});

test("plans and mode changes end runs without being copied", () => {
  assert.deepEqual(buildThreadCommentaryRuns(["one", `two\n${plan}\nthree ${mode} four`]), [
    { breakCopyMarkdown: [], endCopyMarkdown: null },
    { breakCopyMarkdown: ["one\n\ntwo", "three"], endCopyMarkdown: "four" },
  ]);
});

test("a run ending at an item boundary belongs to that item, and break-only items get no copy", () => {
  assert.deepEqual(buildThreadCommentaryRuns(["prose", mode, `${plan}\nafter`]), [
    { breakCopyMarkdown: [], endCopyMarkdown: "prose" },
    { breakCopyMarkdown: [null], endCopyMarkdown: null },
    { breakCopyMarkdown: [null], endCopyMarkdown: "after" },
  ]);
});
