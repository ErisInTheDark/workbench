/*
 * No production exports. Tests protect app-owned duration styling without changing surrounding message content.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkbenchAppLogMessage } from "./workbench-app-log-format.ts";

test("colours app duration tokens without changing surrounding text", () => {
  assert.equal(
    formatWorkbenchAppLogMessage("build finished in 37ms"),
    "build finished in \u001b[35m37ms\u001b[0m",
  );
});
