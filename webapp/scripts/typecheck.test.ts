/* No production exports. Fast typecheck-runner wards cover the complete project list and bounded diagnostic preservation. Keywords: typecheck, config, diagnostics, test. */
import assert from "node:assert/strict";
import test from "node:test";

import { summarizeTypecheckDiagnostics, typecheckProjectConfigs } from "./typecheck.mjs";

test("typecheck runner includes the app and orchestrator projects", () => {
  assert.deepEqual(typecheckProjectConfigs, ["tsconfig.typecheck.json", "orchestrator/tsconfig.json"]);
});

test("typecheck summary keeps unique semantic diagnostics up to its bound", () => {
  const repeated = "client.ts(1,1): error TS2307: Cannot find module './generated'.";
  assert.deepEqual(summarizeTypecheckDiagnostics([
    repeated,
    `${repeated}\nowner.ts(2,2): error TS2304: Cannot find name 'owner'.`,
  ], 2), [
    repeated,
    "owner.ts(2,2): error TS2304: Cannot find name 'owner'.",
  ]);
});
