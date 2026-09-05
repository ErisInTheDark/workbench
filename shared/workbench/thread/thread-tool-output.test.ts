/* No production exports. Keywords: tool output, text, images, unsupported content, provenance. */
import assert from "node:assert/strict";
import test from "node:test";
import { readWorkbenchToolOutput } from "./thread-tool-output.ts";

test("supported output retains native identity, body form and acceptance evidence", () => {
  const text = { id: "fco_one", name: "context", namespace: "workbench", output: "", type: "functionCallOutput" };
  assert.deepEqual(readWorkbenchToolOutput(text), text);
  const image = {
    ...text, workbenchInjectionAcceptedAt: 123,
    output: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "/image.png", detail: "original" }],
  };
  assert.deepEqual(readWorkbenchToolOutput(image), image);
  assert.deepEqual(readWorkbenchToolOutput({ ...text, namespace: null }), { ...text, namespace: null });
});

test("unsupported or malformed outputs remain opaque instead of losing parts", () => {
  const output = { id: "fco_one", name: "context", namespace: null, output: "ok", type: "functionCallOutput" };
  assert.equal(readWorkbenchToolOutput({ ...output, output: [{ type: "input_audio", audio_url: "audio" }] }), null);
  assert.equal(readWorkbenchToolOutput({ ...output, output: [{ type: "input_text", text: "ok" }, { type: "future_content" }] }), null);
  assert.equal(readWorkbenchToolOutput({ ...output, output: [{ type: "input_image" }] }), null);
  assert.equal(readWorkbenchToolOutput({ ...output, id: "" }), null);
  assert.equal(readWorkbenchToolOutput({ ...output, workbenchInjectionAcceptedAt: -1 }), null);
});
