/* No production exports. Tests protect live file-change count rows, terminal diff disclosure, unsuccessful outcomes, and adjacent item order. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchFileChangeItem } from "../../../lib/workbench/thread/workbench-file-change";
import ThreadFileChangeItem, { ThreadFileChangeList } from "./ThreadFileChangeItem";

type FileChangeItem = WorkbenchFileChangeItem;

function update(path: string): FileChangeItem["changes"][number] {
  return {
    diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+extra",
    kind: { move_path: null, type: "update" },
    path,
  };
}

function changes(): FileChangeItem["changes"] {
  return [
    { diff: "+new", kind: { type: "add" }, path: "src/add.ts" },
    { diff: "-old", kind: { type: "delete" }, path: "src/delete.ts" },
    update("src/edit.ts"),
    { ...update("src/move.ts"), kind: { move_path: "src/moved.ts", type: "update" } },
  ];
}

function render(items: FileChangeItem[]) {
  return renderToStaticMarkup(createElement(ThreadFileChangeItem, {
    items,
    projectRootPath: "C:/workspace",
  }));
}

test("in-progress file changes stream count summaries without exposing partial diffs", () => {
  const html = render([{ changes: changes(), id: "live", status: "inProgress", type: "fileChange" }]);

  assert.equal((html.match(/data-thread-file-change-row-mode="static"/gu) ?? []).length, 4);
  assert.match(html, /Creating/u);
  assert.match(html, /Deleting/u);
  assert.match(html, /Editing/u);
  assert.match(html, /Moving/u);
  assert.match(html, />\+2</u);
  assert.match(html, />-1</u);
  assert.doesNotMatch(html, /<details/u);
});

test("completed file changes replace static summaries with final diff disclosures", () => {
  const html = render([{ changes: changes(), id: "final", status: "completed", type: "fileChange" }]);

  assert.equal((html.match(/data-thread-file-change-row-mode="disclosure"/gu) ?? []).length, 4);
  assert.equal((html.match(/<details/gu) ?? []).length, 4);
  assert.match(html, /Created/u);
  assert.match(html, /Deleted/u);
  assert.match(html, /Edited/u);
  assert.match(html, /Moved/u);
  assert.match(html, />\+2</u);
  assert.match(html, />-1</u);
});

test("failed and declined file changes render every action as one static terminal row", () => {
  const html = render([
    { changes: changes(), id: "failed", status: "failed", type: "fileChange" },
    { changes: changes(), id: "unclaimed", status: "failed", type: "fileChange", workbenchFailureKind: "unclaimed" },
    { changes: changes(), id: "declined", status: "declined", type: "fileChange" },
  ]);

  assert.equal((html.match(/data-thread-file-change-row-mode="static"/gu) ?? []).length, 12);
  assert.equal((html.match(/Failed to create/gu) ?? []).length, 3);
  assert.equal((html.match(/Failed to delete/gu) ?? []).length, 3);
  assert.equal((html.match(/Failed to edit/gu) ?? []).length, 3);
  assert.equal((html.match(/Failed to move/gu) ?? []).length, 3);
  assert.equal((html.match(/unclaimed/gu) ?? []).length, 4);
  assert.equal((html.match(/declined/gu) ?? []).length, 4);
  assert.doesNotMatch(html, /data-thread-file-change-outcome="failed"/u);
  assert.doesNotMatch(html, /data-thread-file-change-outcome="declined"/u);
  assert.doesNotMatch(html, /<details/u);
});

test("synthetic unclaimed failures render supplied counts without a captured diff", () => {
  const html = render([{
    changes: [
      { diff: "", kind: { type: "add" }, path: "src/create.ts", workbenchAdditions: 12, workbenchDeletions: 0 },
      { diff: "", kind: { type: "delete" }, path: "src/delete.ts", workbenchAdditions: 0, workbenchDeletions: 3 },
      { diff: "", kind: { move_path: null, type: "update" }, path: "src/edit.ts", workbenchAdditions: 4, workbenchDeletions: 2 },
      { diff: "", kind: { move_path: "src/moved.ts", type: "update" }, path: "src/move.ts", workbenchAdditions: 1, workbenchDeletions: 1 },
    ],
    id: "synthetic-unclaimed",
    status: "failed",
    type: "fileChange",
    workbenchFailureKind: "unclaimed",
  }]);

  assert.equal((html.match(/data-thread-file-change-row-mode="static"/gu) ?? []).length, 4);
  assert.match(html, /Failed to create.*unclaimed/u);
  assert.match(html, /Failed to delete.*unclaimed/u);
  assert.match(html, /Failed to edit.*unclaimed/u);
  assert.match(html, /Failed to move.*unclaimed/u);
  assert.match(html, />\+12</u);
  assert.match(html, />-3</u);
  assert.match(html, />\+4</u);
  assert.match(html, />-2</u);
  assert.doesNotMatch(html, /<details/u);
  assert.doesNotMatch(html, /No diff captured/u);
});

test("reusable no-detail file lists preserve plain rows instead of Codex lifecycle markers", () => {
  const html = renderToStaticMarkup(createElement(ThreadFileChangeList, {
    changes: changes().map((change) => ({ change, detailsAvailable: false })),
  }));

  assert.equal((html.match(/data-thread-file-change-row-mode="plain"/gu) ?? []).length, 4);
  assert.doesNotMatch(html, /data-thread-file-change-row-mode="static"/u);
});
