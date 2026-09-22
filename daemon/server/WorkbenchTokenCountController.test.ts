/* Exports: none. Tests protect GPT-5 counting, source sections, project resolution, admission, cancellation, and bounded failures. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Gpt5TextTokens from "./lib/workbench/commands/gpt-5-text-tokens";
import WorkbenchTokenCountController from "./WorkbenchTokenCountController";

function createController(
  projectRoot: string,
  resolveProjectFromCwd: (cwd: string) => Promise<{ cwd: string; root: { root: string } }>
    = async (cwd) => ({ cwd, root: { root: cwd } }),
) {
  return new WorkbenchTokenCountController({ projectRoot, resolveProjectFromCwd });
}

test("counts exact text and stripped Workbench instructions locally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-token-controller-"));
  const instructionRoot = path.join(root, "instructions");
  await mkdir(instructionRoot, { recursive: true });
  await writeFile(path.join(instructionRoot, "base.md"), "Keep this. <!-- explain failure --> <harness:codex>Keep that.</harness:codex> {macro}");
  const controller = createController(root);
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

test("reports independent source and toc-range counts for Workbench instructions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-token-toc-"));
  const instructionRoot = path.join(root, "instructions");
  await mkdir(instructionRoot, { recursive: true });
  const source = ["plain preamble", "## Policy", "policy body", "### Detail", "detail body"].join("\n");
  await writeFile(path.join(instructionRoot, "base.md"), source);
  const controller = createController(root);

  try {
    const response = await controller.execute({
      callerThreadId: null,
      cwd: root,
      kind: "instructions",
      model: "gpt-5.6",
      toc: true,
    }, new AbortController().signal);
    const output = await response.text();
    assert.match(output, new RegExp(`${Gpt5TextTokens.count(source)} tokens across 1 instruction file`, "u"));
    assert.match(output, new RegExp(`base\\.md: ${Gpt5TextTokens.count(source)} tokens`, "u"));
    assert.match(output, new RegExp(`1-1 \\[preamble\\]: ${Gpt5TextTokens.count("plain preamble")} tokens`, "u"));
    assert.match(output, new RegExp(`2-5 ## Policy: ${Gpt5TextTokens.count("## Policy\npolicy body\n### Detail\ndetail body")} tokens`, "u"));
    assert.match(output, new RegExp(`4-5 ### Detail: ${Gpt5TextTokens.count("### Detail\ndetail body")} tokens`, "u"));
    assert.match(output, /independent[\s\S]*include nested headings[\s\S]*listed once[\s\S]*do not sum/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("counts the fresh AGENTS chain from the catalog-owned root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-token-project-"));
  const cwd = path.join(root, "nested");
  const resolvedCwds: string[] = [];
  const controller = createController(root, async (requestedCwd) => {
    resolvedCwds.push(requestedCwd);
    return { cwd: requestedCwd, root: { root } };
  });

  try {
    await mkdir(cwd);
    await Promise.all([
      writeFile(path.join(root, "AGENTS.md"), "root rule\n<!-- source note -->\n{./leaf}"),
      writeFile(path.join(root, "leaf.md"), "base leaf"),
      writeFile(path.join(root, "leaf.override.md"), "active leaf"),
      writeFile(path.join(cwd, "AGENTS.md"), "nested rule"),
    ]);

    const counted = await controller.execute({
      cwd,
      kind: "projectInstructions",
      model: "gpt-5.6",
    }, new AbortController().signal);
    const expectedContent = "root rule\n\nactive leaf\n\nnested rule";
    assert.deepEqual(resolvedCwds, [cwd]);
    assert.equal(
      await counted.text(),
      `${Gpt5TextTokens.count(expectedContent)} tokens across the resolved project AGENTS chain for gpt-5.6\n`,
    );
    const toc = await controller.execute({
      cwd,
      kind: "projectInstructions",
      model: "gpt-5.6",
      toc: true,
    }, new AbortController().signal);
    const tocOutput = await toc.text();
    assert.match(tocOutput, /AGENTS\.md:/u);
    assert.match(tocOutput, /leaf\.override\.md:/u);
    assert.match(tocOutput, /nested\/AGENTS\.md:/u);
    assert.doesNotMatch(tocOutput, /leaf\.md:/u);

    await writeFile(path.join(root, "AGENTS.md"), "{./missing}");
    const invalidGraph = await controller.execute({
      cwd: root,
      kind: "projectInstructions",
      model: "gpt-5.6",
    }, new AbortController().signal);
    assert.equal(invalidGraph.status, 500);
    assert.match(await invalidGraph.text(), /does not exist[\s\S]*Import chain: AGENTS\.md -> missing/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an owning project with no AGENTS chain counts zero tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-token-empty-project-"));
  const controller = createController(root, async (cwd) => ({ cwd, root: { root } }));
  try {
    const result = await controller.execute({
      cwd: root,
      kind: "projectInstructions",
      model: "gpt-5.6",
    }, new AbortController().signal);
    assert.equal(await result.text(), "0 tokens across the resolved project AGENTS chain for gpt-5.6\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects invalid requests and managed threads outside the Workbench root", async () => {
  const controller = createController("C:/workbench", async () => {
    throw new Error("cwd must be inside a discovered Workbench project.");
  });
  const signal = new AbortController().signal;
  const outside = await controller.execute({ callerThreadId: "thread", cwd: "C:/other", kind: "instructions", model: "gpt-5.6" }, signal);
  assert.equal(outside.status, 403);
  assert.equal(await outside.text(), "Managed threads can count Workbench instructions only from the running Workbench repository root.\n");

  const unsupported = await controller.execute({ cwd: "C:/other", kind: "text", model: "gpt-4.1", text: "hello" }, signal);
  assert.equal(unsupported.status, 400);
  assert.equal(await unsupported.text(), "A valid token count request is required.\n");

  const outsideProject = await controller.execute({
    cwd: "C:/other",
    kind: "projectInstructions",
    model: "gpt-5.6",
  }, signal);
  assert.equal(outsideProject.status, 400);
  assert.match(await outsideProject.text(), /requires a cwd inside a discovered Workbench project/u);
});

test("preserves cancellation and bounds instruction-source failures", async () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled"));
  const controller = createController("C:/missing-workbench");
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

  const failedProject = await controller.execute({
    cwd: "C:/missing-project",
    kind: "projectInstructions",
    model: "gpt-5.6",
  }, new AbortController().signal);
  assert.equal(failedProject.status, 500);
  assert.match(await failedProject.text(), /Project instructions could not be read for token counting/u);
});

test("project resolution preserves caller cancellation", async () => {
  let rejectResolution!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const controller = createController("C:/workbench", async () => {
    markStarted();
    return await new Promise((_resolve, reject) => { rejectResolution = reject; });
  });
  const cancelled = new AbortController();
  const result = controller.execute({
    cwd: "C:/project",
    kind: "projectInstructions",
    model: "gpt-5.6",
  }, cancelled.signal);
  await started;
  cancelled.abort(new Error("cancelled"));
  rejectResolution(new Error("resolution stopped"));

  await assert.rejects(result, /cancelled/u);
});
