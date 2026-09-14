/* No production exports. Tests protect ripgrep argument safety, no-match success, and real failure semantics above shared execution. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodexCommandExecRequest, CodexCommandExecResult } from "./CodexCommandExecController";
import WorkbenchRipgrepController from "./WorkbenchRipgrepController";

test("preserves native arguments and treats matches and no matches as success", async () => {
  const requests: CodexCommandExecRequest[] = [];
  const results: CodexCommandExecResult[] = [
    { exitCode: 0, stderr: "warning\n", stdout: "match\n" },
    { exitCode: 1, stderr: "", stdout: "" },
  ];
  const controller = new WorkbenchRipgrepController({
    commandExec: {
      execute: async (request) => {
        requests.push(request);
        return results.shift()!;
      },
    },
  });
  const input = { args: ["--no-heading", "-n", "a pattern with 'quotes'", "webapp"], cwd: "C:/workspace" };

  const matched = await controller.execute(input, new AbortController().signal);
  assert.equal(matched.status, 200);
  assert.equal(await matched.text(), "match\nwarning\n");
  const unmatched = await controller.execute(input, new AbortController().signal);
  assert.equal(unmatched.status, 200);
  assert.equal(await unmatched.text(), "");
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ({
    command: ["rg", "--no-config", "--heading", ...input.args],
    cwd: input.cwd,
    disableTimeout: true,
    env: { RIPGREP_CONFIG_PATH: null },
    sandboxPolicy: { type: "dangerFullAccess" },
  })));
});

test("rejects process-launching arguments and preserves real ripgrep failures", async () => {
  let executionCount = 0;
  const controller = new WorkbenchRipgrepController({
    commandExec: {
      execute: async () => {
        executionCount += 1;
        return { exitCode: 2, stderr: "invalid regex\n", stdout: "" };
      },
    },
  });

  for (const argument of ["--pre=convert", "--hostname-bin", "--hostname-bin=hostname"]) {
    const response = await controller.execute({ args: [argument, "needle"], cwd: "C:/workspace" }, new AbortController().signal);
    assert.equal(response.status, 400);
  }
  assert.equal(executionCount, 0);

  const failed = await controller.execute({ args: ["["], cwd: "C:/workspace" }, new AbortController().signal);
  assert.equal(failed.status, 400);
  assert.equal(await failed.text(), "invalid regex\n");
  assert.equal(executionCount, 1);
});
