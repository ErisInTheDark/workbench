/* No production exports. Tests protect local GPT-5 counting, cwd admission, corpus stripping, cancellation, and bounded source failures. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import WorkbenchTokenCountController from "./WorkbenchTokenCountController";

test("counts exact text and stripped Workbench instructions locally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-token-controller-"));
  const instructionRoot = path.join(root, "webapp", "lib", "workbench", "instructions");
  await mkdir(instructionRoot, { recursive: true });
  await writeFile(path.join(instructionRoot, "base.md"), "Keep this. <!-- explain failure --> <harness:codex>Keep that.</harness:codex> {macro}");
  const controller = new WorkbenchTokenCountController({ projectRoot: root });
  const signal = new AbortController().signal;

  try {
    const text = await controller.execute({ cwd: "C:/elsewhere", kind: "text", model: "gpt-5.6", text: "exact  text" }, signal);
    assert.equal(await text.text(), "3 tokens for gpt-5.6\n");
    const instructions = await controller.execute({ callerThreadId: null, cwd: "C:/elsewhere", kind: "instructions", model: "gpt-5.6" }, signal);
    assert.equal(await instructions.text(), "7 tokens across 1 instruction file for gpt-5.6\n");
    const managedInstructions = await controller.execute({ callerThreadId: "thread", cwd: root, kind: "instructions", model: "gpt-5.6" }, signal);
    assert.equal(await managedInstructions.text(), "7 tokens across 1 instruction file for gpt-5.6\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects invalid requests and managed threads outside the Workbench root", async () => {
  const controller = new WorkbenchTokenCountController({ projectRoot: "C:/workbench" });
  const signal = new AbortController().signal;
  const outside = await controller.execute({ callerThreadId: "thread", cwd: "C:/other", kind: "instructions", model: "gpt-5.6" }, signal);
  assert.equal(outside.status, 403);
  assert.equal(await outside.text(), "Managed threads can count Workbench instructions only from the running Workbench repository root.\n");

  const unsupported = await controller.execute({ cwd: "C:/other", kind: "text", model: "gpt-4.1", text: "hello" }, signal);
  assert.equal(unsupported.status, 400);
  assert.equal(await unsupported.text(), "A valid token count request is required.\n");
});

test("preserves cancellation and bounds instruction-source failures", async () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled"));
  const controller = new WorkbenchTokenCountController({ projectRoot: "C:/missing-workbench" });
  await assert.rejects(
    controller.execute({ cwd: "C:/other", kind: "text", model: "gpt-5.6", text: "hello" }, cancelled.signal),
    /cancelled/u,
  );
  const failed = await controller.execute({
    callerThreadId: null,
    cwd: "C:/other",
    kind: "instructions",
    model: "gpt-5.6",
  }, new AbortController().signal);
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), "Workbench instruction sources could not be read for token counting.\n");
});
