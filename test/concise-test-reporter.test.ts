/*
 * No exports. Tests protect process-level failure for uncaptured test output.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const reporter = new URL("./concise-test-reporter.mjs", import.meta.url).href;

for (const scenario of [
  { name: "silent passing tests", body: "", succeeds: true },
  { name: "uncaptured stdout", body: "process.stdout.write('stdout sentinel\\n');", succeeds: false },
  { name: "uncaptured stderr", body: "process.stderr.write('stderr sentinel\\n');", succeeds: false },
  { name: "ordinary assertion failures", body: "throw new Error('assertion sentinel');", succeeds: false },
  { name: "output beyond the display budget", body: "process.stdout.write('x'.repeat(20_000));", succeeds: false },
]) {
  test(`reporter preserves the exit outcome for ${scenario.name}`, async context => {
    const directory = await mkdtemp(path.join(tmpdir(), "workbench-noise-reporter-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = path.join(directory, "fixture.test.mjs");
    await writeFile(fixture, `import test from 'node:test';\ntest('fixture', () => { ${scenario.body} });\n`);
    let succeeded = true;
    let output = "";
    try {
      const result = await execute(process.execPath, ["--test", `--test-reporter=${reporter}`, fixture], {
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      output = result.stdout;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number") throw error;
      succeeded = false;
      output = String("stdout" in error ? error.stdout : "");
    }
    assert.equal(succeeded, scenario.succeeds);
    if (scenario.name === "uncaptured stdout") assert.ok(output.includes("stdout sentinel"));
    if (scenario.name === "uncaptured stderr") assert.ok(output.includes("stderr sentinel"));
    if (scenario.name === "ordinary assertion failures") assert.ok(output.includes("assertion sentinel"));
  });
}
