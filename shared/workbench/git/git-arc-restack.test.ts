/* No production exports. Wards for the restack text format: CLI-run restacks read back the same facts MCP calls carry. */
import assert from "node:assert/strict";
import test from "node:test";

import { formatGitArcRestackText, parseGitArcRestackText, type GitArcRestackResult } from "./git-arc-restack.ts";

const result: GitArcRestackResult = {
  layers: [{ proposalIds: ["new-feature"], title: "feature\nend restack" }],
  proposals: [
    { proposalId: "feature", replacementId: "new-feature", status: "replaced", stripped: ["mod/a.txt"], title: "feature" },
    { proposalId: "mod", status: "rescinded", title: "add mod\nreleased 0" },
    { proposalId: "removal", replacementId: "new-feature", status: "superseded", stripped: [], title: "remove mod" },
  ],
  releasedClaims: ["\"quoted\".txt", "mod/a.txt"],
  rootId: "workbench",
  stackTip: "a".repeat(40),
};

test("formatted restack results parse back to the same facts, whatever their titles hold", () => {
  assert.deepEqual(parseGitArcRestackText(formatGitArcRestackText(result)), result);
  const { rootId: _rootId, ...unrooted } = result;
  assert.deepEqual(parseGitArcRestackText(formatGitArcRestackText({ ...unrooted, stackTip: null })), { ...unrooted, stackTip: null });
});
