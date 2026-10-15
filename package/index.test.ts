/*
 * No production exports. Tests dotenv loading with named store replacement.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { config } from "./index.mjs";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";

// WB_STORES double-quoted arguments treat `\\` as one backslash.
const node = `"${process.execPath.replaceAll("\\", "\\\\")}"`;
const stores = [
  `echo: ${node} -e "process.stdout.write('<' + process.argv[1] + '>\\n')" {key}`,
  `ref: ${node} -e "process.stdout.write('$' + '{ref:again}')" {key}`,
  `broken: ${node} -e "process.stdout.write('leak'); process.exit(4)" {key}`,
].join("; ");

async function envFile(t: TestContext, text: string) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-config-");
  t.after(() => temporary.dispose());
  const file = path.join(temporary.path, ".env");
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

test("managed agent processes resolve store references through the configured runner", async t => {
  unmanaged(t);
  process.env.WORKBENCH_THREAD_ID = "thread";
  const file = await envFile(t, "WB_STORES=custom: custom-store {key}\nKEY=${custom:k}\n");
  const calls: string[][] = [];
  const runner = {
    async run(argv: string[]) {
      calls.push(argv);
      return { ok: true as const, stdout: "resolved\n" };
    },
  };
  const { parsed } = await config({ path: file, processEnv: {}, runner, warn: () => {} });
  assert.equal(parsed.KEY, "resolved");
  assert.deepEqual(calls, [["custom-store", "k"]]);
});

test("required mode blanks entire unresolved optional values but preserves successful empty and literal values", async t => {
  const file = await envFile(t, [
    "WB_STORES=test: lookup {key}",
    "REQUIRED=present",
    "PARTIAL=Bearer ${test:missing} ${test:good}",
    "UNKNOWN=${unknown:key}",
    "EMPTY=",
    "EMPTY_LOOKUP=${test:empty}",
    "LITERAL=${test:literal}",
  ].join("\n"));
  const calls: string[] = [];
  const runner = {
    async run(argv: string[]) {
      const key = argv[1];
      calls.push(key);
      return key === "missing"
        ? { ok: false as const, reason: "exit", exitCode: 1 }
        : { ok: true as const, stdout: key === "empty" ? "\n" : key === "literal" ? "${test:missing}" : "secret" };
    },
  };
  const processEnv: Record<string, string> = {};
  const { parsed } = await config({
    path: file, processEnv, required: ["REQUIRED", "EMPTY", "EMPTY_LOOKUP", "LITERAL"], runner, warn: () => {},
  });
  assert.equal(parsed.PARTIAL, "");
  assert.equal(parsed.UNKNOWN, "");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed.EMPTY_LOOKUP, "");
  assert.equal(parsed.LITERAL, "${test:missing}");
  assert.deepEqual(processEnv, parsed);
  assert.equal(calls.filter(key => key === "missing").length, 1);
});

test("required failures aggregate names without writing any environment values", async t => {
  const file = await envFile(t, "GOOD=updated\nA=${test:secret-key}\nB=${unknown:key}\n");
  const processEnv = { GOOD: "existing" };
  await assert.rejects(config({
    path: file, processEnv, override: true, required: ["A", "B", "ABSENT"],
    warn: () => {},
  }), error => {
    assert(error instanceof Error);
    for (const name of ["A", "B", "ABSENT"]) assert.match(error.message, new RegExp(`\\b${name}\\b`));
    assert.doesNotMatch(error.message, /secret-key|updated|existing/);
    return true;
  });
  assert.deepEqual(processEnv, { GOOD: "existing" });
});

test("optional mode requires other dotenv names and fills explicitly absent optional names", async t => {
  const file = await envFile(t, "GOOD=value\nA=${unknown:key}\nB=${unknown:other}\nEMPTY=\n");
  const processEnv: Record<string, string> = {};
  await assert.rejects(config({ path: file, processEnv, optional: ["A"], warn: () => {} }), /\bB\b/);
  assert.deepEqual(processEnv, {});
  const { parsed } = await config({ path: file, processEnv, optional: ["A", "B", "ABSENT"], warn: () => {} });
  assert.deepEqual(parsed, { GOOD: "value", A: "", B: "", EMPTY: "", ABSENT: "" });
  assert.deepEqual(processEnv, parsed);
});

test("empty policy lists select opposite defaults and existing environment values obey override", async t => {
  const file = await envFile(t, "KEY=${unknown:key}\n");
  assert.equal((await config({ path: file, processEnv: {}, required: [], warn: () => {} })).parsed.KEY, "");
  await assert.rejects(config({ path: file, processEnv: {}, optional: [], warn: () => {} }), /\bKEY\b/);
  for (const existing of ["existing", ""]) {
    const processEnv = { KEY: existing };
    await config({ path: file, processEnv, required: ["KEY"], warn: () => {} });
    assert.equal(processEnv.KEY, existing);
    await assert.rejects(config({
      path: file, processEnv, override: true, required: ["KEY"], warn: () => {},
    }), /\bKEY\b/);
    assert.equal(processEnv.KEY, existing);
  }
});

test("malformed store definitions follow missing policy without treating plain values as missing", async t => {
  const file = await envFile(t, 'WB_STORES=invalid\nKEY=${wb:key}\nPLAIN=value\n');
  const { parsed } = await config({ path: file, processEnv: {}, required: ["PLAIN"], warn: () => {} });
  assert.equal(parsed.KEY, "");
  assert.equal(parsed.PLAIN, "value");
  await assert.rejects(config({ path: file, processEnv: {}, optional: [], warn: () => {} }), /\bKEY\b/);
});

test("policy rejects invalid lists before lookups and leaves the target unchanged", async t => {
  const file = await envFile(t, "KEY=${wb:key}\n");
  let calls = 0;
  const runner = { async run() { calls++; return { ok: true as const, stdout: "value" }; } };
  for (const policy of [{ required: [], optional: [] }, { required: "KEY" }, { optional: [null] }]) {
    const processEnv = {};
    await assert.rejects(config({ path: file, processEnv, runner, ...policy }), TypeError);
    assert.deepEqual(processEnv, {});
  }
  assert.equal(calls, 0);
});

test("required names can come only from the environment while file read errors retain their contract", async t => {
  const file = await envFile(t, "");
  const processEnv = { KEY: "" };
  const result = await config({ path: `${file}.missing`, processEnv, required: ["KEY"] });
  assert(result.error);
  assert.deepEqual(result.parsed, {});
  await assert.rejects(config({ path: `${file}.missing`, processEnv: {}, required: ["KEY"] }), /\bKEY\b/);
});

test("undefined target entries are missing, not existing values that block population", async t => {
  const file = await envFile(t, "GOOD=value\nOPTIONAL=${unknown:key}\n");
  const processEnv: Record<string, string | undefined> = { GOOD: undefined, OPTIONAL: undefined, ABSENT: undefined };
  await config({ path: file, processEnv, optional: ["OPTIONAL", "ABSENT"] });
  assert.deepEqual(processEnv, { GOOD: "value", OPTIONAL: "", ABSENT: "" });
});

test("default fallback emits no warnings for failed lookups or invalid store definitions", async t => {
  const warnings: string[] = [];
  t.mock.method(process, "emitWarning", (message: string) => { warnings.push(message); });
  const runner = { async run() { return { ok: false as const, reason: "missing-command" }; } };
  for (const definitions of ["wb: missing-command {key}", "invalid"]) {
    const file = await envFile(t, `WB_STORES=${definitions}\nKEY=\${wb:key}\nPLAIN=value\n`);
    const processEnv: Record<string, string> = {};
    const { parsed } = await config({ path: file, processEnv, runner });
    assert.equal(parsed.KEY, "${wb:key}");
    assert.equal(processEnv.PLAIN, "value");
  }
  assert.deepEqual(warnings, []);
});
