/*
 * No production exports. Tests protect workspace-search result arrangement: per-kind caps, section order and cross-source merging.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WORKBENCH_SEARCH_KIND_LIMITS, arrangeWorkbenchSearchResults, type WorkbenchSearchResult } from "./workbench-search";

const thread = (id: string, score?: number): WorkbenchSearchResult => ({
  detail: "", harnessId: "codex", id, kind: "thread", projectId: "project", threadId: id, title: id, ...(score === undefined ? {} : { score }),
});
const file = (id: string, score?: number): WorkbenchSearchResult => ({
  detail: "", id, kind: "file", path: id, projectId: "project", title: id, ...(score === undefined ? {} : { score }),
});
const action = (score: number): WorkbenchSearchResult => ({
  actionId: "toggle-sidebar", detail: "Ctrl+B", id: "action", kind: "action", score, title: "Toggle sidebar",
});
const arrange = (results: WorkbenchSearchResult[]) => arrangeWorkbenchSearchResults(results, result => result).map(({ id }) => id);

test("a flood of strong threads cannot crowd weaker kinds out of the results", () => {
  const threads = Array.from({ length: 60 }, (_, index) => thread(`thread-${index}`, 3 - index / 100));
  const arranged = arrangeWorkbenchSearchResults([...threads, file("src/needle.ts", 1)], result => result);
  assert.equal(arranged.filter(result => result.kind === "thread").length, WORKBENCH_SEARCH_KIND_LIMITS.thread);
  assert.equal(arranged.at(-1)?.id, "src/needle.ts");
  assert.ok(arranged.length <= 50);
});

test("the kind holding the strongest hit leads and hits stay in score order inside their section", () => {
  assert.deepEqual(arrange([thread("weak", 1.2), action(2.5), thread("strong", 1.9), file("file", 1.5)]),
    ["action", "strong", "weak", "file"]);
});

test("results merged from several sources interleave by score, with unscored hits after scored ones in arrival order", () => {
  const first = [thread("a1", 2.9), thread("a2", 1.1), thread("a-old-1"), thread("a-old-2")];
  const second = [thread("b1", 2.4), thread("b2", 2.0)];
  assert.deepEqual(arrange([...first, ...second]), ["a1", "b1", "b2", "a2", "a-old-1", "a-old-2"]);
});
