/*
 * No production exports. Tests the Linux host environment file preserves the terminal PATH exactly.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory.ts";
import recordHostEnvironment, { hostEnvironmentFilePath } from "./host-environment-file.ts";

test("the recorded PATH decodes to the exact terminal value", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-host-env-");
  context.after(() => temporary.dispose());
  const value = "/home/u/odd dir/$HOME/100%/bin:/a\\b\"c:/usr/bin";
  await recordHostEnvironment({ dataRoot: temporary.path, environment: { PATH: value }, platform: "linux" });
  const contents = await fs.readFile(hostEnvironmentFilePath(temporary.path), "utf8");
  // systemd keeps single-quoted environment-file values literal.
  const match = /^PATH='([^']*)'\n$/u.exec(contents);
  assert.equal(match?.[1], value);
});

test("a PATH systemd cannot hold literally is rejected instead of written altered", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-host-env-");
  context.after(() => temporary.dispose());
  await assert.rejects(recordHostEnvironment({ dataRoot: temporary.path, environment: { PATH: "/it's/bin" }, platform: "linux" }));
  await assert.rejects(fs.access(hostEnvironmentFilePath(temporary.path)));
});
