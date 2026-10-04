/* No production exports. Protect prompt builds from loading (and leaking) a new assembly generation when no source changed. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadWorkbenchPromptAssembly } from "./workbench-prompt-generation";

test("unchanged assembly sources reuse one loaded generation", async () => {
  const first = await loadWorkbenchPromptAssembly();
  const second = await loadWorkbenchPromptAssembly();
  assert.equal(second, first);
});
