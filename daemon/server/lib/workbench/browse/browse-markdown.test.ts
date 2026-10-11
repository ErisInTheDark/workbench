/* No exports. Protect strict BrowseMD grammar, fenced JavaScript, and signed pointer input. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileWorkbenchBrowseMarkdown } from "./browse-markdown";

test("signed wheel deltas remain positional alongside named options", () => {
  const { actions } = compileWorkbenchBrowseMarkdown(
    "mouse scroll 600 300 -25 -150 --session nested --return-xpath",
    { cwd: ".", threadId: "thread" },
  );
  const action = actions[0];
  assert.equal(action?.action, "mouseScroll");
  if (action?.action !== "mouseScroll") assert.fail("Expected wheel input");
  assert.deepEqual([action.x, action.y, action.deltaX, action.deltaY], [600, 300, -25, -150]);
  assert.equal(action.session, "nested");
  assert.equal(action.returnXPath, true);
});

test("keeps quoted JavaScript intact inside the only supported eval form", () => {
  const { actions } = compileWorkbenchBrowseMarkdown(
    "```js\nJSON.stringify(performance.getEntriesByType('navigation')[0])\n```",
    { cwd: ".", threadId: "thread" },
  );
  assert.deepEqual(actions, [{
    action: "eval",
    cwd: ".",
    expression: "JSON.stringify(performance.getEntriesByType('navigation')[0])",
    mode: null,
    persistent: null,
    session: null,
    threadId: "thread",
    timeoutMs: null,
  }]);
});

test("rejects ambiguous inline JavaScript commands", () => {
  assert.throws(
    () => compileWorkbenchBrowseMarkdown("js document.title", { cwd: ".", threadId: "thread" }),
    /Unsupported BrowseMD command "js"/u,
  );
  assert.throws(
    () => compileWorkbenchBrowseMarkdown("eval document.title", { cwd: ".", threadId: "thread" }),
    /Unsupported BrowseMD command "eval"/u,
  );
});

test("rejects unsupported flags instead of silently widening the command", () => {
  assert.throws(
    () => compileWorkbenchBrowseMarkdown("snapshot --selector iframe", { cwd: ".", threadId: "thread" }),
    /snapshot does not support --selector/u,
  );
});

test("compiles init scripts and performance controls", () => {
  const { actions } = compileWorkbenchBrowseMarkdown(
    [
      "```init-js",
      "globalThis.__started = performance.now();",
      "```",
      "emulate device iphone-14",
      "throttle cpu 4",
      "throttle network fast-3g",
      "touch scroll 195 500 0 -900 --speed 800 --fling",
      "trace start",
    ].join("\n"),
    { cwd: ".", session: "perf", threadId: "thread" },
  );
  assert.deepEqual(actions.map(({ action }) => action), [
    "initScript",
    "emulateDevice",
    "throttleCpu",
    "throttleNetwork",
    "touchScroll",
    "trace",
  ]);
});
