/*
 * No production exports. Node tests protect root wb dispatch without starting the real app or daemon.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const rootDispatcherPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "wb");

async function dispatcherFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-root-wb-"));
  const dispatcherPath = path.join(root, "wb");
  const daemonCliPath = path.join(root, "daemon", "server", "lib", "workbench", "cli", "workbench-agent-cli.sh");
  const dispatchPath = path.join(root, "package", "dispatch.mjs");
  await fs.mkdir(path.dirname(daemonCliPath), { recursive: true });
  await fs.mkdir(path.dirname(dispatchPath), { recursive: true });
  await fs.copyFile(rootDispatcherPath, dispatcherPath);
  await fs.mkdir(path.join(root, "app", "server"), { recursive: true });
  await fs.writeFile(path.join(root, "app", "server", "index.ts"), "", "utf8");
  await fs.writeFile(path.join(root, "app", "server", "desktop.ts"), "", "utf8");
  await fs.writeFile(path.join(root, "caller-sentinel"), "", "utf8");
  await fs.writeFile(dispatchPath, [
    "import fs from 'node:fs';",
    "const cwd = fs.existsSync('./caller-sentinel') ? 'preserved' : 'changed';",
    "console.log(`human|cwd=${cwd}|args=${JSON.stringify(process.argv.slice(2))}`);",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(daemonCliPath, [
    "#!/usr/bin/env bash",
    "printf 'daemon|origin=%s|thread=%s|args=' \"${WORKBENCH_ORIGIN:-}\" \"${WORKBENCH_THREAD_ID:-${CODEX_THREAD_ID:-}}\"",
    "printf '%s,' \"$@\"",
    "printf '\\n'",
    "exit \"${FIXTURE_EXIT_CODE:-0}\"",
    "",
  ].join("\n"), "utf8");
  await Promise.all([
    fs.chmod(dispatcherPath, 0o755),
    fs.chmod(daemonCliPath, 0o755),
  ]);
  return { dispatcherPath, root };
}

test("delegates argumentful commands to the existing daemon shell", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const result = await execFileAsync("bash", [fixture.dispatcherPath, "thread", "recall"], {
    cwd: fixture.root,
    env: { ...process.env, CODEX_THREAD_ID: "", WORKBENCH_ORIGIN: "", WORKBENCH_THREAD_ID: "" },
  });
  assert.equal(result.stdout, "daemon|origin=|thread=|args=thread,recall,\n");
  assert.equal(result.stderr, "");
});

test("keeps no-argument managed and hook calls on the daemon shell", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));

  const managed = await execFileAsync("bash", [fixture.dispatcherPath], {
    cwd: fixture.root,
    env: { ...process.env, WORKBENCH_ORIGIN: "http://127.0.0.1:4321", CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "thread-one" },
  });
  assert.match(managed.stdout, /^daemon\|origin=http:\/\/127\.0\.0\.1:4321\|thread=thread-one/u);

  const hook = await execFileAsync("bash", [fixture.dispatcherPath], {
    cwd: fixture.root,
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      WORKBENCH_ORIGIN: "",
      WORKBENCH_APPLY_PATCH_CLAIM_HOOK: "1",
      WORKBENCH_THREAD_ID: "",
    },
  });
  assert.match(hook.stdout, /^daemon\|origin=\|thread=/u);
});

test("routes unthreaded launch through the checkout-owned dispatcher", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const result = await execFileAsync("bash", [fixture.dispatcherPath], {
    cwd: fixture.root,
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      WORKBENCH_DESKTOP_PLATFORM: "other",
      WORKBENCH_THREAD_ID: "",
    },
  });
  assert.equal(result.stdout, "human|cwd=preserved|args=[]\n");
  assert.equal(result.stderr, "");
});

test("keeps Windows human launch on the same dispatcher", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const result = await execFileAsync("bash", [fixture.dispatcherPath], {
    cwd: fixture.root,
    env: {
      ...process.env,
      CODEX_THREAD_ID: "",
      WORKBENCH_DESKTOP_PLATFORM: "win32",
      WORKBENCH_THREAD_ID: "",
    },
  });
  assert.equal(result.stdout, "human|cwd=preserved|args=[]\n");
  assert.equal(result.stderr, "");
});

test("keeps shortcut installation local for humans and delegated for managed agents", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const human = await execFileAsync("bash", [fixture.dispatcherPath, "shortcut"], {
    cwd: fixture.root,
    env: { ...process.env, CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "" },
  });
  assert.equal(human.stdout, 'human|cwd=preserved|args=["shortcut"]\n');

  const managed = await execFileAsync("bash", [fixture.dispatcherPath, "shortcut"], {
    cwd: fixture.root,
    env: { ...process.env, WORKBENCH_ORIGIN: "", CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "thread-one" },
  });
  assert.match(managed.stdout, /^daemon\|origin=\|thread=thread-one\|args=shortcut,/u);
});

test("does not discard extra shortcut arguments", async (context) => {
  const fixture = await dispatcherFixture();
  context.after(async () => await fs.rm(fixture.root, { force: true, recursive: true }));
  const result = await execFileAsync("bash", [fixture.dispatcherPath, "shortcut", "extra"], {
    cwd: fixture.root,
    env: { ...process.env, WORKBENCH_ORIGIN: "", CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "" },
  });
  assert.match(result.stdout, /^daemon\|origin=\|thread=\|args=shortcut,extra,/u);
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
