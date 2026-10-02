/*
 * No production exports. Tests dotenv loading with named store replacement.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { config } from "./index.mjs";

// WB_STORES double-quoted arguments treat `\\` as one backslash.
const node = `"${process.execPath.replaceAll("\\", "\\\\")}"`;
const stores = [
  `echo: ${node} -e "process.stdout.write('<' + process.argv[1] + '>\\n')" {key}`,
  `ref: ${node} -e "process.stdout.write('$' + '{ref:again}')" {key}`,
  `broken: ${node} -e "process.stdout.write('leak'); process.exit(4)" {key}`,
].join("; ");

async function envFile(t: TestContext, text: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".env");
  await fs.writeFile(file, text);
  return file;
}

function unmanaged(t: TestContext) {
  const saved = { thread: process.env.WORKBENCH_THREAD_ID, codex: process.env.CODEX_THREAD_ID };
  delete process.env.WORKBENCH_THREAD_ID;
  delete process.env.CODEX_THREAD_ID;
  t.after(() => {
    if (saved.thread === undefined) delete process.env.WORKBENCH_THREAD_ID;
    else process.env.WORKBENCH_THREAD_ID = saved.thread;
    if (saved.codex !== undefined) process.env.CODEX_THREAD_ID = saved.codex;
  });
}

test("resolved references are replaced once and unresolved ones stay literal", async t => {
  unmanaged(t);
  const file = await envFile(t, [
    `WB_STORES=\`${stores}\``,
    "A=Bearer ${echo:token} and ${echo:token}",
    "B=${ref:x}",
    "C=${broken:k} ${unknown:k} ${PLAIN}",
  ].join("\n"));
  const warnings: string[] = [];
  const processEnv: Record<string, string> = {};
  const { parsed } = await config({ path: file, processEnv, warn: message => warnings.push(message) });
  assert.equal(parsed.A, "Bearer <token> and <token>");
  assert.equal(parsed.B, "${ref:again}");
  assert.equal(parsed.C, "${broken:k} ${unknown:k} ${PLAIN}");
  assert.equal(processEnv.A, parsed.A);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /broken store lookup for C exited with 4/);
  assert.doesNotMatch(warnings[0]!, /leak|process/);
});

test("without Workbench or a reachable store the file still loads with literal references", async t => {
  unmanaged(t);
  const file = await envFile(t, "WB_STORES=wb: workbench-missing-cli-for-test get {key}\nKEY=${wb:service}\nPLAIN=value\n");
  const processEnv: Record<string, string> = {};
  const { parsed } = await config({ path: file, processEnv, warn: () => {} });
  assert.deepEqual(parsed, { WB_STORES: "wb: workbench-missing-cli-for-test get {key}", KEY: "${wb:service}", PLAIN: "value" });
  assert.equal(processEnv.KEY, "${wb:service}");
});

test("existing variables win unless override is set", async t => {
  unmanaged(t);
  const file = await envFile(t, "KEEP=file\n");
  const processEnv: Record<string, string> = { KEEP: "existing" };
  await config({ path: file, processEnv });
  assert.equal(processEnv.KEEP, "existing");
  await config({ path: file, processEnv, override: true });
  assert.equal(processEnv.KEEP, "file");
});

test("managed agent processes run no store commands", async t => {
  unmanaged(t);
  process.env.WORKBENCH_THREAD_ID = "thread";
  const marker = path.join(os.tmpdir(), `wb-config-marker-${process.pid}-${Date.now()}`);
  t.after(() => fs.rm(marker, { force: true }));
  const touch = `custom: ${node} -e "require('fs').writeFileSync(process.argv[1], 'ran')" "${marker.replaceAll("\\", "\\\\")}" {key}`;
  const file = await envFile(t, `WB_STORES=\`${touch}\`\nKEY=\${custom:k}\n`);
  const warnings: string[] = [];
  const { parsed } = await config({ path: file, processEnv: {}, warn: message => warnings.push(message) });
  assert.equal(parsed.KEY, "${custom:k}");
  assert.match(warnings[0]!, /managed agent/);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});
