/* No exports. Tests protect exact scenario-workspace cleanup and path containment. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import IsolatedWorkbench, {
  IsolatedWorkbenchSignalCleanup,
  removeIsolatedWorkbenchWorkspace,
} from "./IsolatedWorkbench";

test("process signals settle every active scenario exactly once before exit", async () => {
  const signals = new EventEmitter();
  const exits: number[] = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  let first = 0;
  let second = 0;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const cleanup = new IsolatedWorkbenchSignalCleanup(
    signals,
    code => {
      exits.push(code);
      resolveExit();
    },
  );
  cleanup.register(async () => {
    first += 1;
    await firstReleased;
  });
  cleanup.register(async () => {
    second += 1;
  });

  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual({ first, second, exits }, { first: 1, second: 1, exits: [] });
  releaseFirst();
  await exited;
  assert.deepEqual(exits, [130]);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

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
