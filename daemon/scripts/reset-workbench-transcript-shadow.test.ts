/*
 * No production exports. Tests protect the explicit transcript reset request and its refusal boundary. Keywords: transcript, reset, script, test.
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sourceScript = fileURLToPath(new URL("./reset-workbench-transcript-shadow.mjs", import.meta.url));

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

test("transcript reset script writes only the exact reload-owned request after explicit confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-reset-script-"));
  const daemon = join(root, "daemon");
  const script = join(daemon, "scripts", "reset-workbench-transcript-shadow.mjs");
  await mkdir(dirname(script), { recursive: true });
  await copyFile(sourceScript, script);
  try {
    const refused = await run(script, daemon, []);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Refusing transcript shadow reset/);

    const accepted = await run(script, daemon, ["--confirm-transcript-shadow-reset"]);
    assert.equal(accepted.code, 0);
    assert.match(accepted.stdout, /Transcript shadow reset requested/);
    assert.equal(
      await readFile(join(root, ".workbench", "reset-workbench-sqlite"), "utf8"),
      "workbench-transcript-shadow-reset-v2\n",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
