/*
 * No production exports. Tests protect standalone app port admission and precedence.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readWorkbenchAppCommandLine } from "./app-command-line.ts";

test("CLI port overrides the environment fallback", () => {
  assert.deepEqual(readWorkbenchAppCommandLine(["--port", "3002"], "4000"), { port: 3002 });
  assert.deepEqual(readWorkbenchAppCommandLine([], "4000"), { port: 4000 });
  assert.deepEqual(readWorkbenchAppCommandLine([], undefined), { port: null });
});

test("invalid standalone app arguments fail before startup", () => {
  assert.throws(() => readWorkbenchAppCommandLine(["--port", "nope"]), /integer/u);
  assert.throws(() => readWorkbenchAppCommandLine(["--port", "3002", "--port", "4000"]), /only once/u);
  assert.throws(() => readWorkbenchAppCommandLine(["--unknown"]), /Unknown option/u);
  assert.throws(() => readWorkbenchAppCommandLine(["positional"]), /positional/u);
});
