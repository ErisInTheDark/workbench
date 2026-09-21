/*
 * No production exports. Tests setup process argument and failure boundaries.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import SetupCommand from "./SetupCommand.mjs";

test("setup forwards literal arguments without shell interpretation", async () => {
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const command = new SetupCommand({ output, errorOutput: output });
  await command.run(process.execPath, [
    "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "has spaces", "$(not-a-command)", "a&b", 'a"b', "tail\\",
  ]);
  assert.deepEqual(JSON.parse(text), ["has spaces", "$(not-a-command)", "a&b", 'a"b', "tail\\"]);
});

test("setup preserves process failures and does not run cancelled commands", async () => {
  const command = new SetupCommand();
  await assert.rejects(command.run(process.execPath, ["-e", "process.exit(7)"]), /7/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(command.run(process.execPath, ["-e", "process.exit(0)"], {
    signal: controller.signal,
  }), { name: "AbortError" });
  await assert.rejects(command.run("workbench-nonexistent-command-for-test", []), /ENOENT/);
});
