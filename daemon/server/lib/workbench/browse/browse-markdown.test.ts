/* No exports. Protect signed mouse input through BrowseMD argument parsing. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileWorkbenchBrowseMarkdown } from "./browse-markdown";

test("signed wheel deltas remain positional alongside named options", () => {
  const { actions } = compileWorkbenchBrowseMarkdown(
    "mouse scroll 600 300 -25 -150 --session nested --return-xpath",
    { cwd: ".", threadId: "thread" },
  );
  const action = actions[0];
  assert.equal(action?.action, "mouseScroll");
  if (action?.action !== "mouseScroll") assert.fail("Expected wheel input");
  assert.deepEqual([action.x, action.y, action.deltaX, action.deltaY], [600, 300, -25, -150]);
  assert.equal(action.session, "nested");
  assert.equal(action.returnXPath, true);
});
