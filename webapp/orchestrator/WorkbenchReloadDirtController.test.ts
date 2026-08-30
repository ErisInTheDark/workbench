/*
 * No production exports. Tests protect the orchestrator instruction observer and its stable snapshot ref.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { observeReloadInstructionSource } from "../lib/workbench/reload-source-observer";
import type { ReloadNodeSourceState } from "./reload-node-source-map";
import WorkbenchReloadDirtController from "./WorkbenchReloadDirtController";

const run = promisify(execFile);

test("observed instruction files join Git-backed orchestrator dirt", async (context) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-orchestrator-reload-dirt-"));
  const git = async (...args: string[]) => await run("git", args, { cwd: repoRoot });
  await git("init");
  await git("config", "user.email", "workbench@example.invalid");
  await git("config", "user.name", "Workbench test");
  await fs.mkdir(path.join(repoRoot, "webapp"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "webapp", "core.ts"), "export const core = 1;\n", "utf8");
  await git("add", ".");
  await git("commit", "-m", "initial");

  const sourceState: ReloadNodeSourceState = {
    dependantClosure: (scopes) => [...scopes],
    descriptors: [
      { access: "operator", description: "Core", destructive: false, paths: ["webapp/core.ts"], safeAll: false, scope: "server:core" },
      { access: "operator", description: "Instructions", destructive: false, paths: [], safeAll: false, scope: "server:instructions" },
    ],
  };
  const controller = new WorkbenchReloadDirtController({
    getSourceState: () => sourceState,
    repoRoot,
  });
  context.after(async () => {
    await controller.dispose();
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  });
  await controller.start();

  const instructionPath = path.join(repoRoot, "webapp", "live-instruction.md");
  await fs.writeFile(instructionPath, "# live\n", "utf8");
  observeReloadInstructionSource(instructionPath);
  assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["server:instructions"]);
  assert.match(
    (await git("rev-parse", "refs/worktree/workbench/reload-snapshot")).stdout,
    /^[0-9a-f]{40}\s*$/u,
  );
});
