/*
 * No production exports. Tests the shell-free store lookup boundary.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import StoreCommandRunner from "./StoreCommandRunner.mjs";

const node = process.execPath;
const dangerousAccess = "DANGEROUSLY_ACCESS_ENV_VARS";

function withoutDangerousAccess(t: TestContext) {
  const saved = process.env[dangerousAccess];
  delete process.env[dangerousAccess];
  t.after(() => {
    if (saved === undefined) delete process.env[dangerousAccess];
    else process.env[dangerousAccess] = saved;
  });
}

test("lookups receive literal arguments without shell interpretation", async () => {
  const result = await new StoreCommandRunner().run([
    node, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "$(echo hi)", "a&b|c", "%PATH%",
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.ok ? result.stdout : ""), ["$(echo hi)", "a&b|c", "%PATH%"]);
});

test("the packaged wb lookup alone receives deliberate environment access", async t => {
  withoutDangerousAccess(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-store-runner-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packagedWb = path.join(directory, "wb.mjs");
  await fs.writeFile(packagedWb, `process.stdout.write(process.env.${dangerousAccess} ?? "missing");\n`);
  const runner = new StoreCommandRunner({ packagedWb });

  const packaged = await runner.run(["wb", "store", "get", "KEY"]);
  const custom = await runner.run([node, "-e", `process.stdout.write(process.env.${dangerousAccess} ?? "missing")`]);

  assert.equal(packaged.ok && packaged.stdout, "1");
  assert.equal(custom.ok && custom.stdout, "missing");
  assert.equal(process.env[dangerousAccess], undefined);
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
