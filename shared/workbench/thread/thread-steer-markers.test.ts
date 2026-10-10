/* No production exports. Protect transcript-hidden screenshot markers: still recognised as screenshot steers, hidden only when marked so. */
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentScreenshotSteerText, isAgentScreenshotSteerText, isHiddenAgentScreenshotContent, isHiddenAgentScreenshotSteerText } from "./thread-steer-markers";

test("a hidden screenshot marker is still a screenshot steer, and only it is hidden", () => {
  const hidden = createAgentScreenshotSteerText({ hidden: true });
  const shown = createAgentScreenshotSteerText();
  assert.ok(isAgentScreenshotSteerText(hidden));
  assert.ok(isHiddenAgentScreenshotSteerText(hidden));
  assert.equal(isHiddenAgentScreenshotSteerText(shown), false);
  assert.equal(isHiddenAgentScreenshotSteerText("<!-- workbench-agent-screenshot-steer {nope} -->"), false);
  assert.ok(isHiddenAgentScreenshotContent([{ type: "input_text", text: hidden }, { type: "input_image" }]));
  assert.equal(isHiddenAgentScreenshotContent([{ type: "text", text: shown }]), false);
});
