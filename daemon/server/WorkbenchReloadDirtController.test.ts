/*
 * No production exports. Tests protect the daemon instruction observer and its stable snapshot ref.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { observeReloadInstructionSource } from "./lib/workbench/reload-source-observer";
import type { ReloadDirtSourceState as ReloadNodeSourceState } from "workbench-shared/reload/ReloadDirtController";
import WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";

const run = promisify(execFile);

test("observed instruction files join Git-backed daemon dirt", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-daemon-reload-dirt-");
  const repoRoot = temporary.path;
  const git = async (...args: string[]) => await run("git", args, { cwd: repoRoot });
  await git("init");
  await git("config", "user.email", "workbench@example.invalid");
  await git("config", "user.name", "Workbench test");
  await fs.mkdir(path.join(repoRoot, "daemon"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "daemon", "core.ts"), "export const core = 1;\n", "utf8");
  await git("add", ".");
  await git("commit", "-m", "initial");

  const sourceState: ReloadNodeSourceState = {
    dependantClosure: (scopes) => [...scopes],
    descriptors: [
      { access: "operator", description: "Core", destructive: false, paths: ["daemon/core.ts"], safeAll: false, scope: "server:core" },
      { access: "operator", description: "Instructions", destructive: false, paths: [], safeAll: false, scope: "server:instructions" },
    ],
  };
  const controller = new WorkbenchReloadDirtController({
    getSourceState: () => sourceState,
    repoRoot,
  });
  context.after(async () => {
    await controller.dispose();
    await temporary.dispose();
  });
  await controller.start();

  const instructionPath = path.join(repoRoot, "daemon", "live-instruction.md");
  await fs.writeFile(instructionPath, "# live\n", "utf8");
  observeReloadInstructionSource(instructionPath);
  assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["server:instructions"]);
  assert.match(
    (await git("rev-parse", "refs/worktree/workbench/reload-snapshot")).stdout,
    /^[0-9a-f]{40}\s*$/u,
  );
});
