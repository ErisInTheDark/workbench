/* No production exports. Tests protect exact OpenAI request shape, cwd admission, corpus stripping, and bounded failures. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import WorkbenchTokenCountController from "./WorkbenchTokenCountController";

test("counts exact text and stripped Workbench instructions through the official endpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-token-controller-"));
  const instructionRoot = path.join(root, "webapp", "lib", "workbench", "instructions");
  await mkdir(instructionRoot, { recursive: true });
  await writeFile(path.join(instructionRoot, "base.md"), "Keep this. <!-- explain failure --> <harness:codex>Keep that.</harness:codex> {macro}");
  const requests: Array<{ body: object; signal: AbortSignal; url: string }> = [];
  const controller = new WorkbenchTokenCountController({
    apiKey: () => "secret",
    fetchRequest: async (input, init) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as object,
        signal: init!.signal as AbortSignal,
        url: String(input),
      });
      return Response.json({ input_tokens: requests.length * 10, object: "response.input_tokens" });
    },
    projectRoot: root,
  });
  const signal = new AbortController().signal;

  try {
    const text = await controller.execute({ cwd: "C:/elsewhere", kind: "text", model: "gpt-test", text: "exact  text" }, signal);
    assert.equal(await text.text(), "10 tokens for gpt-test\n");
    const instructions = await controller.execute({ callerThreadId: null, cwd: "C:/elsewhere", kind: "instructions", model: "gpt-test" }, signal);
    assert.equal(await instructions.text(), "20 tokens across 1 instruction file for gpt-test\n");
    const managedInstructions = await controller.execute({ callerThreadId: "thread", cwd: root, kind: "instructions", model: "gpt-test" }, signal);
    assert.equal(await managedInstructions.text(), "30 tokens across 1 instruction file for gpt-test\n");
    assert.deepEqual(requests, [{
      body: { input: "exact  text", model: "gpt-test" },
      signal,
      url: "https://api.openai.com/v1/responses/input_tokens",
    }, {
      body: { input: "", instructions: "Keep this.  Keep that.", model: "gpt-test" },
      signal,
      url: "https://api.openai.com/v1/responses/input_tokens",
    }, {
      body: { input: "", instructions: "Keep this.  Keep that.", model: "gpt-test" },
      signal,
      url: "https://api.openai.com/v1/responses/input_tokens",
    }]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects managed threads outside the Workbench root and surfaces bounded boundary failures", async () => {
  let fetchCount = 0;
  const controller = new WorkbenchTokenCountController({
    apiKey: () => "secret",
    fetchRequest: async () => {
      fetchCount += 1;
      return new Response("secret upstream body", { status: 429 });
    },
    projectRoot: "C:/workbench",
  });
  const outside = await controller.execute({ callerThreadId: "thread", cwd: "C:/other", kind: "instructions", model: "gpt-test" }, new AbortController().signal);
  assert.equal(outside.status, 403);
  assert.equal(await outside.text(), "Managed threads can count Workbench instructions only from the running Workbench repository root.\n");
  assert.equal(fetchCount, 0);
  const failed = await controller.execute({ cwd: "C:/other", kind: "text", model: "gpt-test", text: "hello" }, new AbortController().signal);
  assert.equal(failed.status, 502);
  assert.equal(await failed.text(), "OpenAI token counting failed with status 429.\n");
  assert.equal(fetchCount, 1);

  const missingKey = new WorkbenchTokenCountController({ apiKey: () => undefined, projectRoot: "C:/workbench" });
  const unavailable = await missingKey.execute({ cwd: "C:/other", kind: "text", model: "gpt-test", text: "hello" }, new AbortController().signal);
  assert.equal(unavailable.status, 503);
});
