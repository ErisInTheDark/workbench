/* No production exports. Tests protect actual write evidence and interruption fencing. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Error as ToolError, Result } from "@opencode/plugin/promise/tool";
import { parseUnifiedDiff } from "workbench-shared/workbench/thread/unified-diff";
import OpenCodeFileEvidenceController from "./OpenCodeFileEvidenceController";

test("settled evidence captures creation and formatted overwrites without replacing native output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-file-evidence-"));
  const owner = new OpenCodeFileEvidenceController({
    isManagedSession: async () => true, resolveCwd: async () => root, warn: message => assert.fail(message),
  });
  try {
    const input = { tool: "write", sessionID: "session", id: "first", input: { path: "file.ts", content: "requested" } };
    await owner.before(input);
    await fs.writeFile(path.join(root, "file.ts"), "formatted\nresult\n");
    const completed = { ...input, status: "completed" as const, result: { output: { existed: false }, content: "native output" } as Result };
    await owner.after(completed);
    assert.equal(completed.result.content, "native output");
    assert.equal(completed.result.metadata?.files[0]?.status, "added");
    assert.equal(parseUnifiedDiff(completed.result.metadata?.files[0]?.patch ?? "").additions, 2);
    await owner.before({ ...input, id: "second" });
    await fs.writeFile(path.join(root, "file.ts"), "formatted\nchanged\n");
    const next = { ...input, id: "second", status: "completed" as const, result: { output: { existed: true } } as Result };
    await owner.after(next);
    const diff = parseUnifiedDiff(next.result.metadata?.files[0]?.patch ?? "");
    assert.deepEqual([diff.additions, diff.deletions], [1, 1]);
    assert.equal(next.result.metadata?.files[0]?.status, "modified");
  } finally {
    await owner.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed calls retain attempted kind while interrupted reads cannot publish evidence", async () => {
  let resolveRead!: (value: string | null) => void;
  const owner = new OpenCodeFileEvidenceController({
    isManagedSession: async () => true, resolveCwd: async () => process.cwd(),
    readText: async () => null, warn: message => assert.fail(message),
  });
  const input = { tool: "write", sessionID: "session", id: "failed", input: { path: "new.ts", content: "new" } };
  await owner.before(input);
  const failed = { ...input, status: "error" as const, error: new Error("denied") as ToolError };
  await owner.after(failed);
  assert.equal(failed.error.message, "denied");
  assert.equal((failed.error.metadata?.files as Array<{ status: string }> | undefined)?.[0]?.status, "added");
  await owner.dispose();

  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const interrupted = new OpenCodeFileEvidenceController({
    isManagedSession: async () => true, resolveCwd: async () => process.cwd(),
    readText: () => { started(); return new Promise(resolve => { resolveRead = resolve; }); },
    warn: message => assert.fail(message),
  });
  const before = interrupted.before(input);
  await reading;
  const settlement = interrupted.settleSession("session");
  resolveRead(null);
  await before;
  await settlement;
  const result: Result = { content: "original" };
  await interrupted.after({ ...input, status: "completed", result });
  assert.equal(result.metadata, undefined);
  await interrupted.dispose();
});

test("disposal waits for owned observations and prevents late metadata publication", async () => {
  let began!: () => void;
  const reading = new Promise<void>(resolve => { began = resolve; });
  let finish!: (text: string | null) => void;
  const owner = new OpenCodeFileEvidenceController({
    isManagedSession: async () => true, resolveCwd: async () => process.cwd(),
    readText: () => { began(); return new Promise(resolve => { finish = resolve; }); },
    warn: message => assert.fail(message),
  });
  const input = { tool: "write", sessionID: "session", id: "call", input: { path: "file.ts" } };
  const before = owner.before(input);
  await reading;
  let drained = false;
  const disposal = Promise.resolve(owner.dispose()).then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false, "disposal must not outlive its file observations");
  finish(null);
  await Promise.all([before, disposal]);
  const event = { ...input, status: "completed" as const, result: {} as Result };
  await owner.after(event);
  assert.equal(event.result.metadata, undefined);
});

test("independent calls and baseline failures do not corrupt native outcomes", async () => {
  const warnings: string[] = [];
  const owner = new OpenCodeFileEvidenceController({
    isManagedSession: async session => session !== "ordinary", resolveCwd: async () => process.cwd(),
    readText: async file => {
      if (file.endsWith("broken.ts")) throw new Error("PRIVATE failure detail");
      return file.endsWith("old.ts") ? "before" : null;
    },
    warn: message => { warnings.push(message); },
  });
  const inputs = ["new.ts", "old.ts", "broken.ts"].map((file, index) => ({
    tool: "write", sessionID: "managed", id: String(index), input: { path: file },
  }));
  await Promise.all(inputs.map(input => owner.before(input)));
  const errors = inputs.map(input => ({ ...input, status: "error" as const, error: new Error("native failure") as ToolError }));
  for (const event of errors.toReversed()) await owner.after(event);
  assert.equal((errors[0].error.metadata?.files as Array<{ status: string }>)[0]?.status, "added");
  assert.equal((errors[1].error.metadata?.files as Array<{ status: string }>)[0]?.status, "modified");
  assert.equal(errors[2].error.metadata, undefined);
  assert.ok(errors.every(event => event.error.message === "native failure"));
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings.join(""), /PRIVATE/);
  const ordinary = { ...inputs[0], sessionID: "ordinary", status: "completed" as const, result: {} as Result };
  await owner.before(ordinary);
  await owner.after(ordinary);
  assert.equal(ordinary.result.metadata, undefined);
  await owner.dispose();
});
