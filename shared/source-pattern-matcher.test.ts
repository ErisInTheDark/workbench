/* No production exports. Tests protect ordered gitignore-like matching, ** spanning zero directories, and directory-scope overlap. */
import assert from "node:assert/strict";
import test from "node:test";

import { createGitignoreMatcher } from "./source-pattern-matcher.ts";

test("matches ordered include and negation patterns", () => {
  const matcher = createGitignoreMatcher(`
/webapp/lib/
!**/*.test.*
`);
  assert.equal(matcher.matches("webapp/lib/source.ts"), true);
  assert.equal(matcher.matches("webapp/lib/source.test.ts"), false);
  assert.equal(matcher.matches("other/source.ts"), false);
});

test("** spans zero or more directories", () => {
  const nested = createGitignoreMatcher("instructions/**/*.md");
  assert.equal(nested.matches("instructions/AGENTS.md"), true);
  assert.equal(nested.matches("instructions/a/b/c.md"), true);
  assert.equal(nested.matches("other/AGENTS.md"), false);

  const leading = createGitignoreMatcher("**/generated/**");
  assert.equal(leading.matches("generated/x.ts"), true);
  assert.equal(leading.matches("a/generated/x.ts"), true);

  const negated = createGitignoreMatcher("*.ts\n!**/*.test.*");
  assert.equal(negated.matches("source.test.ts"), false);
  assert.equal(negated.matches("source.ts"), true);
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
