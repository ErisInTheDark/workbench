/* No production exports. Tests protect whole-file packing, rendered page bounds, oversized exclusion, and direct diff bypass. */
import assert from "node:assert/strict";
import test from "node:test";

import type { GitCheckpointFileChange } from "./checkpoint-contracts";
import { createGitArcDiffPage, type GitArcDiffPageUnit } from "./git-arc-diff-pages";

function unit(path: string, content: string, groupHeading?: string): GitArcDiffPageUnit {
  const change: GitCheckpointFileChange = {
    additions: 1,
    deletions: 0,
    diff: content,
    kind: { type: "update", move_path: null },
    path,
  };
  return { change, content, ...(groupHeading ? { groupHeading } : {}) };
}

test("packs whole files into bounded pages and keeps source order inside each page", () => {
  const units = [
    unit("a.ts", "aaaaaa"),
    unit("b.ts", "bbbbbb"),
    unit("c.ts", "cccc"),
  ];
  const first = createGitArcDiffPage(units, { maxCharacters: 12, page: 1, paginate: true });
  const second = createGitArcDiffPage(units, { maxCharacters: 12, page: 2, paginate: true });

  assert.equal(first.diff.length <= 12, true);
  assert.equal(second.diff.length <= 12, true);
  assert.deepEqual(first.changes.map(({ path }) => path), ["a.ts", "c.ts"]);
  assert.deepEqual(second.changes.map(({ path }) => path), ["b.ts"]);
  assert.equal(first.nextPage, 2);
  assert.equal(second.nextPage, null);
});

test("counts group headings and separators in the rendered page budget", () => {
  const units = [
    unit("api/a.ts", "aaaa", "### api"),
    unit("api/b.ts", "bbbb", "### api"),
  ];
  const first = createGitArcDiffPage(units, { maxCharacters: 17, page: 1, paginate: true });
  const second = createGitArcDiffPage(units, { maxCharacters: 17, page: 2, paginate: true });

  assert.deepEqual(first.changes.map(({ path }) => path), ["api/a.ts"]);
  assert.deepEqual(second.changes.map(({ path }) => path), ["api/b.ts"]);
  assert.equal(first.diff.length <= 17, true);
  assert.equal(second.diff.length <= 17, true);
});

test("omits oversized files only from paged diff output", () => {
  const units = [unit("giant.ts", "x".repeat(20)), unit("small.ts", "small")];
  const paged = createGitArcDiffPage(units, { maxCharacters: 10, paginate: true });
  const direct = createGitArcDiffPage(units, { maxCharacters: 10, paginate: false });

  assert.deepEqual(paged.changes.map(({ path }) => path), ["small.ts"]);
  assert.deepEqual(paged.oversizedDiffPaths, ["giant.ts"]);
  assert.deepEqual(direct.changes.map(({ path }) => path), ["giant.ts", "small.ts"]);
  assert.equal(direct.diff.includes("x".repeat(20)), true);
  assert.deepEqual(direct.oversizedDiffPaths, []);
});

test("rejects page numbers beyond the current packed result", () => {
  assert.throws(
    () => createGitArcDiffPage([unit("a.ts", "a")], { maxCharacters: 10, page: 2, paginate: true }),
    /page 2 does not exist/u,
  );
});
