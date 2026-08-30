/*
 * No production exports. Tests protect the browser-origin domain marker in app logs.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchAppLogger from "./WorkbenchAppLogger.ts";

test("formats browser diagnostics with the client domain", () => {
  const errors: string[] = [];
  const logger = new WorkbenchAppLogger({
    color: false,
    now: () => new Date(2026, 0, 1, 1, 2, 3),
    writeError: (value) => errors.push(value),
  });
  logger.error("client", "[warn] something happened");
  assert.deepEqual(errors, ["01:02:03 client [warn] something happened\n"]);
});

test("prefixes every stack line with the client domain", () => {
  const errors: string[] = [];
  const logger = new WorkbenchAppLogger({
    color: false,
    now: () => new Date(2026, 0, 1, 1, 2, 3),
    writeError: (value) => errors.push(value),
  });
  logger.error("client", "boom\nat owner");
  assert.equal(errors[0], "01:02:03 client boom\n01:02:03 client at owner\n");
});
