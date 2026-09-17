/* No exports. Tests protect exact scenario-workspace cleanup and path containment. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import IsolatedWorkbench, { removeIsolatedWorkbenchWorkspace } from "./IsolatedWorkbench";

test("removes only the exact owned scenario workspace", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-scenario-cleanup-"));
  context.after(async () => await fs.rm(temporary, { force: true, recursive: true }));
  const fixtures = path.join(temporary, "test-runs");
  const root = path.join(fixtures, "wb-scenario-owned");
  const external = path.join(temporary, "external");
  await fs.mkdir(path.join(root, "codex", ".sandbox"), { recursive: true });
  await fs.mkdir(path.join(external, "secrets"), { recursive: true });
  await fs.writeFile(path.join(external, "secrets", "retained.txt"), "external");
  await fs.writeFile(path.join(external, "marker.json"), "external");
  await fs.writeFile(path.join(root, "codex", "auth.json"), "fixture");
  await fs.symlink(path.join(external, "secrets"), path.join(root, "codex", ".sandbox-secrets"),
    process.platform === "win32" ? "junction" : "dir");
  await fs.link(path.join(external, "marker.json"), path.join(root, "codex", ".sandbox", "setup_marker.json"));
  await fs.writeFile(path.join(root, "retained.txt"), "fixture");

  await removeIsolatedWorkbenchWorkspace(fixtures, root, true);

  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(external, "secrets", "retained.txt"), "utf8"), "external");
  assert.equal(await fs.readFile(path.join(external, "marker.json"), "utf8"), "external");
  await assert.rejects(
    removeIsolatedWorkbenchWorkspace(fixtures, path.join(temporary, "wb-scenario-foreign"), false),
    /direct child/u,
  );
});

test("failed setup removes its allocated scenario workspace", async (context) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-scenario-setup-"));
  context.after(async () => await fs.rm(source, { force: true, recursive: true }));

  await assert.rejects(
    IsolatedWorkbench.create(source, AbortSignal.timeout(5_000), { codexIdentity: false }),
    /ENOENT/u,
  );

  assert.deepEqual(await fs.readdir(path.join(source, ".workbench", "test-runs")), []);
});
