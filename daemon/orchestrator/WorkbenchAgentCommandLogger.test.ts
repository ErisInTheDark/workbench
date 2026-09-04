/* No production exports. Tests protect pending cadence and omission, questionnaire waits, terminal outcomes, cancellation, and timer cleanup for CLI/MCP timing logs. */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchAgentCommandLogger from "./WorkbenchAgentCommandLogger";

test("logs repeated pending warnings and one successful completion", async () => {
  let now = 0;
  let callback: (() => void) | null = null;
  const lines: string[] = [];
  const logger = new WorkbenchAgentCommandLogger({
    cancel: () => { callback = null; },
    now: () => now,
    schedule: (next) => {
      callback = next;
      return 1 as never;
    },
    writeLine: (line) => { lines.push(line.replace(/\u001b\[[0-9;]*m/gu, "")); },
  });
  let finish = (_value: string) => undefined;
  const operation = new Promise<string>((resolve) => { finish = resolve; });
  const completion = logger.run("wb git arc compare", new AbortController().signal, async () => await operation);

  now = 2_000;
  callback?.();
  now = 4_000;
  callback?.();
  finish("done");
  assert.equal(await completion, "done");
  assert.deepEqual(lines, [
    " CLI wb git arc compare pending after 2.0s",
    " CLI wb git arc compare pending after 4.0s",
    " CLI wb git arc compare ok in 4.0s",
  ]);
  assert.equal(callback, null);
});

test("omits pending warnings for normal long waits while preserving completion logs", async () => {
  let scheduled = 0;
  const lines: string[] = [];
  const logger = new WorkbenchAgentCommandLogger({
    now: () => 4_000,
    schedule: () => {
      scheduled += 1;
      return scheduled as never;
    },
    writeLine: (line) => { lines.push(line.replace(/\u001b\[[0-9;]*m/gu, "")); },
  });

  await logger.run("wb shell", new AbortController().signal, async () => "done");
  await logger.run("wb git arc wait", new AbortController().signal, async () => "done");
  await logger.run("wb request user input", new AbortController().signal, async () => "done");

  assert.equal(scheduled, 0);
  assert.deepEqual(lines, [
    " CLI wb shell ok in 0ms",
    " CLI wb git arc wait ok in 0ms",
    " CLI wb request user input ok in 0ms",
  ]);
});

test("reports failed responses and cancelled exceptions without leaking timers", async () => {
  const lines: string[] = [];
  let activeTimers = 0;
  const logger = new WorkbenchAgentCommandLogger({
    cancel: () => { activeTimers -= 1; },
    schedule: () => {
      activeTimers += 1;
      return activeTimers as never;
    },
    writeLine: (line) => { lines.push(line.replace(/\u001b\[[0-9;]*m/gu, "")); },
  });

  await logger.run("wb git arc diff", new AbortController().signal, async () => Response.json({}, { status: 400 }), (response) => response.ok);
  const cancellation = new AbortController();
  await assert.rejects(logger.run("wb shell", cancellation.signal, async () => {
    cancellation.abort(new Error("cancelled"));
    throw cancellation.signal.reason;
  }), /cancelled/u);

  assert.match(lines[0] ?? "", /CLI wb git arc diff error in/u);
  assert.match(lines[1] ?? "", /CLI wb shell cancelled in/u);
  assert.equal(activeTimers, 0);
});

test("keeps internal reload re-entry out of terminal command logs", async () => {
  const lines: string[] = [];
  const cancellation = new AbortController();
  const logger = new WorkbenchAgentCommandLogger({
    schedule: () => 1 as never,
    writeLine: (line) => { lines.push(line); },
  });
  const reload = new Error("Workbench command generation was replaced.");
  Reflect.set(reload, Symbol.for("workbench.agentMcpRuntimeReloadInterruption.v1"), true);

  await assert.rejects(logger.run("wb request user input", cancellation.signal, async () => {
    cancellation.abort(reload);
    throw reload;
  }), /generation was replaced/u);
  assert.deepEqual(lines, []);

  const successfulRetirement = new AbortController();
  assert.equal(await logger.run("wb git arc wait", successfulRetirement.signal, async () => {
    successfulRetirement.abort(reload);
    return "started";
  }), "started");
  assert.match(lines[0] ?? "", /wb git arc wait.*ok/u);
});
