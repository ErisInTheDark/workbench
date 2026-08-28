/* No production exports. Tests protect GPT-5 model admission and exact plain-text o200k_base tokenization. */
import assert from "node:assert/strict";
import { test } from "node:test";

import Gpt5TextTokens from "./gpt-5-text-tokens";

test("counts ordinary GPT-5 text with o200k_base", () => {
  assert.equal(Gpt5TextTokens.encoding, "o200k_base");
  assert.equal(Gpt5TextTokens.count("hello world"), 2);
  assert.equal(Gpt5TextTokens.count("Kia ora, Chiri! ✨"), 9);
  assert.doesNotThrow(() => Gpt5TextTokens.count("<|endoftext|>"));
});

test("recognizes only GPT-5-family model identifiers", () => {
  assert.equal(Gpt5TextTokens.supports("gpt-5"), true);
  assert.equal(Gpt5TextTokens.supports("gpt-5.6"), true);
  assert.equal(Gpt5TextTokens.supports("gpt-5-codex"), true);
  assert.equal(Gpt5TextTokens.supports("gpt-4.1"), false);
  assert.equal(Gpt5TextTokens.supports("gpt-50"), false);
});
