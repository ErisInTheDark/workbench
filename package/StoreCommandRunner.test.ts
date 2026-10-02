/*
 * No production exports. Tests the shell-free store lookup boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import StoreCommandRunner from "./StoreCommandRunner.mjs";

const node = process.execPath;

test("lookups receive literal arguments without shell interpretation", async () => {
  const result = await new StoreCommandRunner().run([
    node, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "$(echo hi)", "a&b|c", "%PATH%",
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.ok ? result.stdout : ""), ["$(echo hi)", "a&b|c", "%PATH%"]);
});

test("failures report only bounded reasons", async () => {
  const runner = new StoreCommandRunner({ maxOutputBytes: 8 });
  assert.deepEqual(await runner.run([node, "-e", "process.stdout.write('secret'); process.exit(3)"]), { ok: false, reason: "exit", exitCode: 3 });
  assert.deepEqual(await runner.run([node, "-e", "process.stdout.write('x'.repeat(64))"]), { ok: false, reason: "output-limit" });
  assert.deepEqual(await runner.run(["workbench-missing-store-command-for-test"]), { ok: false, reason: "missing-command" });
});

test("aborting kills the lookup and rejects", async () => {
  const controller = new AbortController();
  const lookup = new StoreCommandRunner().run([node, "-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(lookup, /stop/);
});
