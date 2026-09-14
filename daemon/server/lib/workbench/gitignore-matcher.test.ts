/* No production exports. Tests protect ordered gitignore-like matching and directory-scope overlap. */
import assert from "node:assert/strict";
import test from "node:test";

import { createGitignoreMatcher } from "./gitignore-matcher";

test("matches ordered include and negation patterns", () => {
  const matcher = createGitignoreMatcher(`
/webapp/lib/
!**/*.test.*
`);
  assert.equal(matcher.matches("webapp/lib/source.ts"), true);
  assert.equal(matcher.matches("webapp/lib/source.test.ts"), false);
  assert.equal(matcher.matches("other/source.ts"), false);
});

test("directory scopes overlap positive descendant patterns", () => {
  const matcher = createGitignoreMatcher(`
/webapp/daemon/WorkbenchBrowseController.ts
/webapp/lib/workbench/browse/
`);
  assert.equal(matcher.matchesPathOrDescendant("webapp"), true);
  assert.equal(matcher.matchesPathOrDescendant("webapp/lib/workbench/browse"), true);
  assert.equal(matcher.matchesPathOrDescendant("webapp/components"), false);
});
