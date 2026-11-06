/* No production exports. Tests protect GPT-5 model admission and exact plain-text o200k_base tokenization. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

import Gpt5TextTokens from "./gpt-5-text-tokens";

test("counts ordinary GPT-5 text with o200k_base", () => {
  assert.equal(Gpt5TextTokens.encoding, "o200k_base");
  assert.equal(Gpt5TextTokens.count("hello world"), 2);
  assert.equal(Gpt5TextTokens.count("Kia ora, Chiri! ✨"), 9);
  assert.doesNotThrow(() => Gpt5TextTokens.count("<|endoftext|>"));
});

const diverseCjk = (length: number) => Array.from({ length }, (_, index) => String.fromCodePoint(0x4e00 + (index * 7919) % 20000)).join("");

test("text without long unbroken runs keeps the tokenizer's exact count", () => {
  const code = Array.from({ length: 200 }, (_, index) => `export const value${index} = compute("item-${index}", ${index});`).join("\n");
  const exact = new Tiktoken(o200kBase).encode(code, [], []).length;
  assert.deepEqual(Gpt5TextTokens.measure(code), { estimated: false, tokens: exact });
});

test("long unbroken runs that would stall the tokenizer stay close to its count, and say they are estimates", () => {
  for (const run of ["x".repeat(1500), "-".repeat(1500), "abc".repeat(500), diverseCjk(300)]) {
    const exact = new Tiktoken(o200kBase).encode(run, [], []).length;
    const { estimated, tokens } = Gpt5TextTokens.measure(`before ${run} after`);
    assert.equal(estimated, true);
    assert.ok(Math.abs(tokens - exact) <= exact * 0.2 + 5, `${run.slice(0, 5)}: ${tokens} against ${exact}`);
  }
});

test("a million repeated characters no longer take the tokenizer's quadratic path", () => {
  const before = performance.now();
  assert.equal(Gpt5TextTokens.measure("x".repeat(1_000_000)).estimated, true);
  assert.ok(performance.now() - before < 5_000);
});

test("only long runs count toward the cheap slowness signal", () => {
  assert.equal(Gpt5TextTokens.longRunChars("ordinary words stay out of it"), 0);
  assert.equal(Gpt5TextTokens.longRunChars(`word ${"x".repeat(100)} word ${"-".repeat(70)}`), 170);
});

test("recognizes only GPT-5-family model identifiers", () => {
  assert.equal(Gpt5TextTokens.supports("gpt-5"), true);
  assert.equal(Gpt5TextTokens.supports("gpt-5.6"), true);
  assert.equal(Gpt5TextTokens.supports("gpt-5-codex"), true);
  assert.equal(Gpt5TextTokens.supports("gpt-4.1"), false);
  assert.equal(Gpt5TextTokens.supports("gpt-50"), false);
});
