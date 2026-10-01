/* No production exports. Tests protect Claude prompt translation for text and image input. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudePromptContent, prefixClaudePrompt } from "./claude-prompt-content";

const text = (value: string) => ({ type: "text" as const, text: value, text_elements: [] });
const png = (data: string) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } });

test("text-only input stays the exact newline-joined string Claude already receives", async () => {
  assert.equal(await claudePromptContent([
    text("hello"), { type: "skill", name: "react", path: "C:/skills/react" }, { type: "mention", name: "a", path: "src/a.ts" },
  ]), "hello\n/react\n@src/a.ts");
});

test("images become content blocks in input order alongside merged text", async context => {
  const dir = await mkdtemp(join(tmpdir(), "claude-prompt-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "shot.PNG");
  await writeFile(path, Buffer.from("local-bytes"));
  assert.deepEqual(await claudePromptContent([
    text("look"), text("here"), { type: "image", url: "data:image/png;base64,AAAA" },
    { type: "localImage", path }, { type: "image", url: "https://example.com/a.webp" }, text("thanks"),
  ]), [
    { type: "text", text: "look\nhere" }, png("AAAA"), png(Buffer.from("local-bytes").toString("base64")),
    { type: "image", source: { type: "url", url: "https://example.com/a.webp" } }, { type: "text", text: "thanks" },
  ]);
});

test("input Claude cannot read is rejected before a turn starts", async () => {
  await assert.rejects(claudePromptContent([{ type: "image", url: "data:image/svg+xml;base64,AAAA" }]), /image\/svg\+xml/u);
  await assert.rejects(claudePromptContent([{ type: "localImage", path: "C:/missing/shot.bmp" }]), /\.bmp/u);
  await assert.rejects(claudePromptContent([{ type: "image", url: "file:///C:/shot.png" }]), /data URL/u);
  await assert.rejects(claudePromptContent([{ type: "localAudio", path: "C:/a.wav" }]), /localAudio/u);
});

test("prefixes lead the prompt whether it starts with text or an image", () => {
  assert.equal(prefixClaudePrompt("ctx", "hi"), "ctx\n\nhi");
  assert.deepEqual(prefixClaudePrompt("ctx", [{ type: "text", text: "hi" }, png("A")]), [{ type: "text", text: "ctx\n\nhi" }, png("A")]);
  assert.deepEqual(prefixClaudePrompt("ctx", [png("A")]), [{ type: "text", text: "ctx" }, png("A")]);
});
