/*
 * No production exports. Node tests protect package-to-checkout delegation.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packageAdapterPath = path.resolve(import.meta.dirname, "wb");

async function packageFixture(options: { checkoutCli?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-package-wb-"));
  const adapterPath = path.join(root, "package", "wb");
  const checkoutCliPath = path.join(root, "wb");
  const workingDirectory = path.join(root, "project");
  await fs.mkdir(path.dirname(adapterPath), { recursive: true });
  await fs.mkdir(workingDirectory);
  await fs.copyFile(packageAdapterPath, adapterPath);
  await fs.writeFile(path.join(workingDirectory, "caller-sentinel"), "", "utf8");

  if (options.checkoutCli !== false) {
    await fs.writeFile(checkoutCliPath, [
      "#!/usr/bin/env bash",
      "if [[ -f ./caller-sentinel ]]; then printf 'cwd=preserved|args='; else printf 'cwd=changed|args='; fi",
      "printf '%s,' \"$@\"",
      "printf '\\n'",
      "exit \"${FIXTURE_EXIT_CODE:-0}\"",
      "",
    ].join("\n"), "utf8");
  }

  return { adapterPath, root, workingDirectory };
}

test("delegates to the checkout wb with the caller context", async (context) => {
  const fixture = await packageFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const result = await execFileAsync("bash", [fixture.adapterPath, "thread", "recall"], {
    cwd: fixture.workingDirectory,
  });
  assert.equal(result.stdout, "cwd=preserved|args=thread,recall,\n");
  assert.equal(result.stderr, "");
});

test("preserves delegated failure and reports a missing checkout", async (context) => {
  const fixture = await packageFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  await assert.rejects(
    execFileAsync("bash", [fixture.adapterPath, "unsupported"], {
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
    execFileAsync("bash", [missingFixture.adapterPath], {
      cwd: missingFixture.workingDirectory,
    }),
    (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? "", /Workbench checkout CLI is unavailable/u);
      return true;
    },
  );
});
