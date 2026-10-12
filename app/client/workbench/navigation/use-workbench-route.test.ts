/*
 * No production exports. Regression tests protect launch canonicalisation across asynchronous app-state loading.
 */
import assert from "node:assert/strict";
import test from "node:test";

import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import { canCanonicalizeWorkbenchRoute } from "./use-workbench-route";

test("launch waits for app state without delaying other route canonicalisation", () => {
  assert.equal(canCanonicalizeWorkbenchRoute("/launch", 0), false);
  assert.equal(canCanonicalizeWorkbenchRoute("/launch", appStateReleases.initialAppState.version), true);
  assert.equal(canCanonicalizeWorkbenchRoute("/launch", appStateReleases.lastProjectSelection.version), true);
  assert.equal(canCanonicalizeWorkbenchRoute("/project/@/", 0), true);
});
