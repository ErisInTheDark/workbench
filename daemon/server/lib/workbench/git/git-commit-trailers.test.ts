/* No production exports. Tests protect Co-authored-by replacement without disturbing message bodies or other trailers. */
import assert from "node:assert/strict";
import test from "node:test";

import { replaceCoAuthorTrailers } from "./git-commit-trailers";

test("replaces co-authors inside the final trailer block and keeps other trailers", () => {
  assert.equal(
    replaceCoAuthorTrailers("title\n\nbody: not a trailer block\nprose\n\nSigned-off-by: A <a@x>\nco-authored-by: Old <old@x>\n", ["New <new@x>"]),
    "title\n\nbody: not a trailer block\nprose\n\nSigned-off-by: A <a@x>\nCo-authored-by: New <new@x>\n",
  );
});

test("strips co-authors and drops an emptied trailer block", () => {
  assert.equal(replaceCoAuthorTrailers("title\n\nCo-authored-by: Old <old@x>\n", []), "title\n");
});

test("appends a trailer block when the message has none", () => {
  assert.equal(replaceCoAuthorTrailers("title\n", ["New <new@x>"]), "title\n\nCo-authored-by: New <new@x>\n");
  assert.equal(replaceCoAuthorTrailers("title\n\nbody prose\n", ["New <new@x>"]), "title\n\nbody prose\n\nCo-authored-by: New <new@x>\n");
});
