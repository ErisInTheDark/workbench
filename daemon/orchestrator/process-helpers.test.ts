/* No production exports. Tests protect platform-safe child-process argument transport. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createSpawnOptions, getSpawnDescriptor } from "./process-helpers";

test("Windows spawn descriptors preserve spaces, shell metacharacters, quotes, and trailing slashes", {
  skip: process.platform !== "win32",
}, () => {
  const expected = [
    "hooks.PreToolUse=[{matcher='^apply_patch$',hooks=[{type='command',command='wb __hook apply-patch-claim'}]}]",
    'quoted "value"',
    "trailing\\",
  ];
  const descriptor = getSpawnDescriptor({
    args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...expected],
    command: process.execPath,
  });
  const result = spawnSync(descriptor.command, descriptor.args, {
    ...createSpawnOptions(process.cwd(), process.env, true),
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
