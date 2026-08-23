/* No production exports. Tests protect exact Workbench-project cwd capability selection. */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { getWorkbenchProjectCapabilities } from "./workbench-project-capabilities";

test("enables reload scopes only for the exact running Workbench project cwd", () => {
  const root = path.resolve("workbench-project");
  assert.deepEqual(getWorkbenchProjectCapabilities(root, root), { reloadScopes: true });
  assert.deepEqual(getWorkbenchProjectCapabilities(path.join(root, "webapp"), root), { reloadScopes: false });
  assert.deepEqual(getWorkbenchProjectCapabilities(null, root), { reloadScopes: false });
});
