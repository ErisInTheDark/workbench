/*
 * No production exports. Node tests protect package-to-checkout delegation.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packageAdapterPath = path.resolve(import.meta.dirname, "wb");

async function packageFixture(options: { checkoutCli?: boolean } = {}) {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-package-wb-");
  const root = temporary.path;
  const adapterPath = path.join(root, "package", "wb");
  const checkoutCliPath = path.join(root, "cli", "dispatch.mjs");
  const workingDirectory = path.join(root, "project");
  await fs.mkdir(path.dirname(adapterPath), { recursive: true });
  await fs.mkdir(path.dirname(checkoutCliPath), { recursive: true });
  await fs.mkdir(path.join(root, "installation"), { recursive: true });
  await fs.mkdir(workingDirectory);
  await fs.copyFile(packageAdapterPath, adapterPath);
  for (const name of [
    "WorkbenchBootstrap.mjs",
    "WorkbenchInstallPrompt.mjs",
    "installer-cube.mjs",
    "WorkbenchBootstrapCommand.mjs",
  ]) {
    await fs.copyFile(path.join(import.meta.dirname, name), path.join(root, "package", name));
  }
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "workbench-root", type: "module" }));
  await fs.writeFile(path.join(root, "installation", "install.mjs"), "");
  await fs.writeFile(path.join(root, "wb"), "");
  await fs.writeFile(path.join(workingDirectory, "caller-sentinel"), "", "utf8");

  if (options.checkoutCli !== false) {
    await fs.writeFile(checkoutCliPath, [
      "import fs from 'node:fs';",
      "process.stdout.write(`${fs.existsSync('./caller-sentinel') ? 'cwd=preserved' : 'cwd=changed'}|args=`);",
      "process.stdout.write(`${process.argv.slice(2).map(value => `${value},`).join('')}\\n`);",
      "process.exitCode = Number(process.env.FIXTURE_EXIT_CODE ?? 0);",
      "",
    ].join("\n"), "utf8");
  }

  return { adapterPath, root, workingDirectory };
}

test("delegates to the checkout CLI with the caller context", async (context) => {
  const fixture = await packageFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const result = await execFileAsync(process.execPath, [fixture.adapterPath, "thread", "recall"], {
    cwd: fixture.workingDirectory,
  });
  assert.equal(result.stdout, "cwd=preserved|args=thread,recall,\n");
  assert.equal(result.stderr, "");
});

test("preserves delegated failure and reports a missing checkout", async (context) => {
  const fixture = await packageFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [fixture.adapterPath, "unsupported"], {
      cwd: fixture.workingDirectory,
      env: { ...process.env, FIXTURE_EXIT_CODE: "7" },
    }),
    (error: NodeJS.ErrnoException & { code?: number }) => {
      assert.equal(error.code, 7);
      return true;
    },
  );

  const missingFixture = await packageFixture({ checkoutCli: false });
  context.after(async () => await fs.rm(missingFixture.root, { force: true, recursive: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [missingFixture.adapterPath], {
      cwd: missingFixture.workingDirectory,
      env: { ...process.env, WORKBENCH_THREAD_ID: "fixture-managed-thread" },
    }),
    (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? "", /Managed threads cannot install or launch/u);
      return true;
    },
  );
});
