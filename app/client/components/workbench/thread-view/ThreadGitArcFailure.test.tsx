/*
 * No production exports. Tests protect standalone historical Git arc failure rendering.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { GitArcFailure } from "workbench-shared/workbench/git/git-arc-failures";
import ThreadGitArcFailure from "./ThreadGitArcFailure";

test("historical Git arc failures render without a live Workbench client", () => {
  const ref = "a".repeat(40);
  const failure: GitArcFailure = {
    action: "arcStart",
    code: "missingArcRef",
    ref,
    version: 1,
  };

  const html = renderToStaticMarkup(<ThreadGitArcFailure failure={failure} />);

  assert.match(html, /data-thread-git-arc-failure="missingArcRef"/u);
  assert.match(html, new RegExp(ref, "u"));
});
