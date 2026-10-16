/* No exports. Protect lossless Codex image framing and conservative native decoding. */
import assert from "node:assert/strict";
import test from "node:test";
import { frameCodexAttachmentInput, stripCodexAttachmentFrames } from "./attachment-input.ts";

test("each packet numbers its images while preserving content and canonical input", () => {
  const text = { type: "text", text: "compare #[attach:1] with #[attach:2]", text_elements: [] };
  const first = { type: "image", url: "image:first", detail: "original" };
  const second = { type: "localImage", path: "/second.png", detail: "high" };
  const input = [text, first, second];
  const framed = frameCodexAttachmentInput(input);
  assert.equal(framed.length, 7);
  assert.equal(framed[0], text);
  assert.equal(framed[2], first);
  assert.equal(framed[5], second);
  assert.deepEqual(stripCodexAttachmentFrames(framed), input);
  assert.deepEqual(frameCodexAttachmentInput(input), framed);
  assert.equal(input.length, 3);
});

test("decoding retains ordinary prose, incomplete wrappers and wrappers around non-images", () => {
  const text = (text: string) => ({ type: "text", text, text_elements: [] });
  const opening = text('<wb:attachment id="attach:1">');
  const closing = text("</wb:attachment>");
  const image = { type: "image", url: "image:first" };
  for (const input of [
    [text("example <wb:attachment id=\"attach:1\">"), image, closing],
    [opening, image],
    [opening, text("not an image"), closing],
  ]) assert.deepEqual(stripCodexAttachmentFrames(input), input);
});
