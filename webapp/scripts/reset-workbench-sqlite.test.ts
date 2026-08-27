/*
 * No production exports. Tests protect explicit admission, exact reset scope, idempotence, and fail-closed deletion. Keywords: sqlite, reset, shadow, script.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts", "reset-workbench-sqlite.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-sqlite-reset-"));
  const webapp = path.join(root, "webapp");
  const storage = path.join(root, ".workbench");
  await mkdir(webapp);
  await mkdir(storage);
  return {
    databasePath: path.join(storage, "workbench.sqlite3"),
    requestPath: path.join(storage, "reset-workbench-sqlite"),
    root,
    storage,
    webapp,
  };
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("confirmed reset requests reload-owned deletion without touching stored data", async () => {
  const { databasePath, requestPath, root, storage, webapp } = await fixture();
  try {
    const targets = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    await Promise.all(targets.map(async (target, index) => await writeFile(target, `sqlite-${index}`, "utf8")));
    const preserved = path.join(storage, "transcripts.json");
    await writeFile(preserved, "keep", "utf8");

    const result = await execFileAsync(process.execPath, [scriptPath, "--confirm-shadow-reset"], { cwd: webapp });

    assert.match(result.stdout, /SQLite shadow reset requested/u);
    assert.deepEqual(await Promise.all(targets.map(exists)), [true, true, true]);
    assert.equal(await readFile(requestPath, "utf8"), "workbench-sqlite-shadow-reset-v1\n");
    assert.equal(await readFile(preserved, "utf8"), "keep");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the exact existing reset request is idempotent", async () => {
  const { requestPath, root, webapp } = await fixture();
  try {
    await writeFile(requestPath, "workbench-sqlite-shadow-reset-v1\n", "utf8");
    const first = await execFileAsync(process.execPath, [scriptPath, "--confirm-shadow-reset"], { cwd: webapp });
    const second = await execFileAsync(process.execPath, [scriptPath, "--confirm-shadow-reset"], { cwd: webapp });
    assert.match(first.stdout, /SQLite shadow reset requested/u);
    assert.match(second.stdout, /SQLite shadow reset requested/u);
    assert.equal(await readFile(requestPath, "utf8"), "workbench-sqlite-shadow-reset-v1\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("reset refuses missing confirmation and the wrong working directory", async () => {
  const { databasePath, root, webapp } = await fixture();
  try {
    await writeFile(databasePath, "keep", "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath], { cwd: webapp }),
      (error: unknown) => error instanceof Error && /exactly --confirm-shadow-reset/u.test(error.message),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath, "--confirm-shadow-reset"], { cwd: root }),
      (error: unknown) => error instanceof Error && /outside the Workbench webapp directory/u.test(error.message),
    );
    assert.equal(await readFile(databasePath, "utf8"), "keep");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an unexpected reset request fails without replacing it", async () => {
  const { requestPath, root, webapp } = await fixture();
  try {
    await writeFile(requestPath, "unexpected", "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath, "--confirm-shadow-reset"], { cwd: webapp }),
      (error: unknown) => error instanceof Error
        && /Refusing to replace an unexpected SQLite reset request/u.test(error.message)
        && !/SQLite shadow reset requested/u.test(error.message),
    );
    assert.equal(await readFile(requestPath, "utf8"), "unexpected");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
