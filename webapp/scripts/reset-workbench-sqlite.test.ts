/*
 * Regression wards for the explicit SQLite reset request and its refusal boundary.
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sourceScript = fileURLToPath(new URL("./reset-workbench-sqlite.mjs", import.meta.url));

function run(scriptPath: string, cwd: string, args: string[]) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

test("reset script writes only the exact reload-owned reset request after explicit confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-reset-script-"));
  const webapp = join(root, "webapp");
  const script = join(webapp, "scripts", "reset-workbench-sqlite.mjs");
  await mkdir(dirname(script), { recursive: true });
  await copyFile(sourceScript, script);
  try {
    const refused = await run(script, webapp, []);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Refusing SQLite shadow reset/);

    const accepted = await run(script, webapp, ["--confirm-shadow-reset"]);
    assert.equal(accepted.code, 0);
    assert.match(accepted.stdout, /SQLite shadow reset requested/);
    assert.equal(
      await readFile(join(root, ".workbench", "reset-workbench-sqlite"), "utf8"),
      "workbench-sqlite-shadow-reset-v1\n",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
