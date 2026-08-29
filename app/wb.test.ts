/*
 * No production exports. Node tests protect root wb dispatch without starting the real app or orchestrator.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const rootDispatcherPath = path.resolve(import.meta.dirname, "..", "wb");

async function dispatcherFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-root-wb-"));
  const dispatcherPath = path.join(root, "wb");
  const orchestratorCliPath = path.join(root, "webapp", "lib", "workbench", "cli", "workbench-agent-cli.sh");
  const tsxCliPath = path.join(root, "app", "node_modules", "tsx", "dist", "cli.mjs");
  await fs.mkdir(path.dirname(orchestratorCliPath), { recursive: true });
  await fs.mkdir(path.dirname(tsxCliPath), { recursive: true });
  await fs.copyFile(rootDispatcherPath, dispatcherPath);
  await fs.writeFile(path.join(root, "app", "index.ts"), "", "utf8");
  await fs.writeFile(path.join(root, "caller-sentinel"), "", "utf8");
  await fs.writeFile(tsxCliPath, [
    "import fs from 'node:fs';",
    "const cwd = fs.existsSync('./caller-sentinel') ? 'preserved' : 'changed';",
    "console.log(`tsx|cwd=${cwd}|entry=${process.argv[2] ?? ''}`);",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(orchestratorCliPath, [
    "#!/usr/bin/env bash",
    "printf 'orchestrator|origin=%s|thread=%s|args=' \"${WORKBENCH_ORIGIN:-}\" \"${WORKBENCH_THREAD_ID:-${CODEX_THREAD_ID:-}}\"",
    "printf '%s,' \"$@\"",
    "printf '\\n'",
    "exit \"${FIXTURE_EXIT_CODE:-0}\"",
    "",
  ].join("\n"), "utf8");
  await Promise.all([
    fs.chmod(dispatcherPath, 0o755),
    fs.chmod(orchestratorCliPath, 0o755),
  ]);
  return { dispatcherPath, root };
}

test("delegates argumentful commands to the existing orchestrator shell", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const result = await execFileAsync("bash", [fixture.dispatcherPath, "thread", "recall"], {
    cwd: fixture.root,
    env: { ...process.env, CODEX_THREAD_ID: "", WORKBENCH_ORIGIN: "", WORKBENCH_THREAD_ID: "" },
  });
  assert.equal(result.stdout, "orchestrator|origin=http://127.0.0.1:4500|thread=|args=thread,recall,\n");
  assert.equal(result.stderr, "");
});

test("keeps no-argument managed and hook calls on the orchestrator shell", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));

  const managed = await execFileAsync("bash", [fixture.dispatcherPath], {
    cwd: fixture.root,
    env: { ...process.env, CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "thread-one" },
  });
  assert.match(managed.stdout, /^orchestrator\|origin=http:\/\/127\.0\.0\.1:4500\|thread=thread-one/u);

  const hook = await execFileAsync("bash", [fixture.dispatcherPath], {
    cwd: fixture.root,
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      WORKBENCH_APPLY_PATCH_CLAIM_HOOK: "1",
      WORKBENCH_THREAD_ID: "",
    },
  });
  assert.match(hook.stdout, /^orchestrator\|origin=http:\/\/127\.0\.0\.1:4500\|thread=/u);
});

test("starts the typed app entry only for an unthreaded no-argument call", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const result = await execFileAsync("bash", [fixture.dispatcherPath], {
    cwd: fixture.root,
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      WORKBENCH_THREAD_ID: "",
    },
  });
  assert.match(result.stdout, /^tsx\|cwd=preserved\|entry=.*[\\/]app[\\/]index\.ts\n$/u);
  assert.equal(result.stderr, "");
});

test("preserves delegated exit status", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  await assert.rejects(
    execFileAsync("bash", [fixture.dispatcherPath, "unsupported"], {
      cwd: fixture.root,
      env: { ...process.env, FIXTURE_EXIT_CODE: "7" },
    }),
    (error: NodeJS.ErrnoException & { code?: number }) => {
      assert.equal(error.code, 7);
      return true;
    },
  );
});
