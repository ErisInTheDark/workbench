/*
 * Exports:
 * - tests: protect exact OpenCode session caller binding and admitted Codex sandbox execution.
 */
import assert from "node:assert/strict";
import test from "node:test";
import OpenCodeToolsController from "./OpenCodeToolsController";

test("binds MCP session identity and runs shell through admitted execution", async () => {
  const executions: object[] = [];
  const controller = new OpenCodeToolsController({
    resolveCaller: async () => ({
      harness: "opencode",
        threadId: "00000000-0000-4000-8000-000000000001",
      cwd: process.cwd(),
    } as never),
    execute: async request => {
      executions.push(request);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    executeReadOnly: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });

  const result = await controller.shell(
    { command: "echo ok", login: false },
    { sessionID: "native-session" },
    new AbortController().signal,
  );
  assert.equal(result.stdout, "ok");
  assert.equal(executions.length, 1);
  assert.deepEqual((executions[0] as { caller: object }).caller, {
    harness: "opencode",
    threadId: "00000000-0000-4000-8000-000000000001",
    cwd: process.cwd(),
  });
  assert.deepEqual((executions[0] as { permissions: object }).permissions, {
    mode: "restricted",
    writableRoots: [process.cwd()],
    network: false,
  });
});
