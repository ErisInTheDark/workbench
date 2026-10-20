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

test("rejects unquoted multi-word selectors instead of dropping the remainder", () => {
  assert.throws(
    () => compileWorkbenchBrowseMarkdown("click text=Save draft", { cwd: ".", threadId: "thread" }),
    /click takes at most 1 argument but got 2/u,
  );
  assert.throws(
    () => compileWorkbenchBrowseMarkdown("fill text=Message box hello", { cwd: ".", threadId: "thread" }),
    /fill takes at most 2 arguments but got 3/u,
  );
  const { actions } = compileWorkbenchBrowseMarkdown("click '[aria-label=\"Remove attached image 2\"]'", { cwd: ".", threadId: "thread" });
  assert.equal(actions[0]?.action === "click" ? actions[0].selector : null, "[aria-label=\"Remove attached image 2\"]");
});

test("types at focus or into a target without folding the target into the text", () => {
  const { actions } = compileWorkbenchBrowseMarkdown(
    "type 'hello world'\ntype '[aria-label=\"Message thread\"]' 'hello world'\ntype @0-4 ' padded '",
    { cwd: ".", threadId: "thread" },
  );
  assert.deepEqual(actions.map((action) => action.action === "type"
    ? { ref: action.ref ?? null, selector: action.selector ?? null, text: action.text } : null), [
    { ref: null, selector: null, text: "hello world" },
    { ref: null, selector: "[aria-label=\"Message thread\"]", text: "hello world" },
    { ref: "0-4", selector: null, text: " padded " },
  ]);
  assert.throws(
    () => compileWorkbenchBrowseMarkdown("type text=Message box hello", { cwd: ".", threadId: "thread" }),
    /type takes at most 2 arguments but got 3/u,
  );
});

test("screenshots one element when given a target", () => {
  const { actions } = compileWorkbenchBrowseMarkdown("screenshot @0-35\nscreenshot", { cwd: ".", threadId: "thread" });
  assert.deepEqual(actions.map((action) => action.action === "screenshot" ? action.ref ?? null : undefined), ["0-35", null]);
});

test("fills explicit empty and whitespace-preserving values", () => {
  const { actions } = compileWorkbenchBrowseMarkdown("fill @e1 \"\"\nfill @e2 \"  padded \"", { cwd: ".", threadId: "thread" });
  assert.deepEqual(actions.map((action) => action.action === "fill" ? action.value : null), ["", "  padded "]);
  assert.throws(
    () => compileWorkbenchBrowseMarkdown("fill @e1", { cwd: ".", threadId: "thread" }),
    /fill requires a value/u,
  );
});

test("compiles init scripts and performance controls", () => {
  const { actions } = compileWorkbenchBrowseMarkdown(
    [
      "```init-js",
      "globalThis.__started = performance.now();",
      "```",
      "emulate device iphone-14",
      "emulate color-scheme dark",
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
    "emulateColorScheme",
    "throttleCpu",
    "throttleNetwork",
    "touchScroll",
    "trace",
  ]);
  assert.throws(
    () => compileWorkbenchBrowseMarkdown("emulate color-scheme sepia", { cwd: ".", threadId: "thread" }),
    /color scheme/u,
  );
});
