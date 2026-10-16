/*
 * Exports:
 * - No production exports; tests protect that status commit lists collapse into one closed group per kind.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ThreadGitArcStatusDetails from "./ThreadGitArcStatusDetails";

const proposals = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({
  proposalId: `${prefix}-${index}`,
  title: `${prefix} title ${index}`,
}));

test("status commit lists collapse into one closed group per kind", () => {
  const markup = renderToStaticMarkup(createElement(ThreadGitArcStatusDetails, {
    output: "",
    status: {
      accepted: proposals("accepted", 3).map(proposal => ({ ...proposal, commitSha: "a".repeat(40) })),
      pending: proposals("pending", 20),
      stacked: [{ pending: proposals("layer", 2), title: "lower layer" }],
    },
  }));
  for (const [group, count] of [["stacked:0", "2 proposals"], ["pending", "20 proposals"], ["accepted", "3 commits"]] as const) {
    const match = new RegExp(`<details[^>]*data-thread-git-arc-status-group="${group}"[^>]*>`).exec(markup);
    assert.ok(match, `${group} group renders`);
    assert.doesNotMatch(match[0], /\bopen\b/, `${group} group starts closed`);
    assert.match(markup, new RegExp(count));
  }
  assert.doesNotMatch(markup, /pending title 0/, "closed groups do not render their rows");
});
