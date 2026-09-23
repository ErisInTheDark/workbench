/*
 * No production exports. Tests protect process framing, producer styling, derived views, and child-line activity evidence.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchProcessLogger from "./WorkbenchProcessLogger.ts";

test("formats browser diagnostics with the client domain", () => {
  const errors: string[] = [];
  const logger = new WorkbenchProcessLogger({
    color: false,
    now: () => new Date(2026, 0, 1, 1, 2, 3),
    writeError: (value) => errors.push(value),
  });
  logger.error("client", "\u001b[33m[warn]\u001b[0m something happened");
  assert.deepEqual(errors, ["01:02:03 client [warn] something happened\n"]);
});

test("prefixes every stack line with the client domain", () => {
  const errors: string[] = [];
  const logger = new WorkbenchProcessLogger({
    color: false,
    now: () => new Date(2026, 0, 1, 1, 2, 3),
    writeError: (value) => errors.push(value),
  });
  logger.error("client", "boom\nat owner");
  assert.equal(errors[0], "01:02:03 client boom\n01:02:03 client at owner\n");
});

test("frames scoped browser database diagnostics with their browser tag", () => {
  const output: string[] = [];
  const logger = new WorkbenchProcessLogger({
    now: () => new Date(2026, 0, 1, 1, 2, 3),
    writeOutput: value => output.push(value),
  });
  logger.line("browser:ca9bf66e", "DB backup pending");
  assert.match(output[0] ?? "", /\u001b\[[0-9]+mbrowser:ca9bf66e\u001b\[0m DB backup pending\n/u);
});

test("reports only complete non-empty child lines as activity", () => {
  const output: string[] = [];
  let activity = 0;
  const logger = new WorkbenchProcessLogger({
    color: false,
    now: () => new Date(2026, 0, 1, 1, 2, 3),
    writeOutput: (value) => output.push(value),
  });
  const stream = logger.createLineStream("daemon", false, () => { activity += 1; });

  stream.write("partial");
  stream.write(" line\n\nsecond");
  assert.equal(activity, 1);
  stream.flush();

  assert.equal(activity, 2);
  assert.deepEqual(output, [
    "01:02:03 daemon partial line\n",
    "01:02:03 daemon second\n",
  ]);
});

test("derived coloured views preserve producer ANSI and share the original sinks", () => {
  const output: string[] = [];
  const logger = new WorkbenchProcessLogger({
    now: () => new Date(2026, 0, 1, 1, 2, 3),
    writeOutput: (value) => output.push(value),
  }).withMessageFormatter((message) => `app:${message}`);

  logger.line("daemon", "\u001b[32mok\u001b[0m");

  assert.deepEqual(output, [
    "\u001b[90m01:02:03\u001b[0m \u001b[36mdaemon\u001b[0m app:\u001b[32mok\u001b[0m\n",
  ]);
});
