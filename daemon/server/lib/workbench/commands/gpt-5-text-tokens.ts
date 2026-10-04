/*
 * Exports:
 * - default Gpt5TextTokens: recognize GPT-5 model identifiers and count plain text with their o200k_base encoding. Keywords: GPT-5, tokens, o200k_base, tiktoken.
 */
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

// The tokenizer is immutable but ~45MB, and reload generations of this module can stay alive side by side,
// so the whole process shares one, built on first use.
const TOKENIZER_KEY = Symbol.for("workbench.gpt-5-text-tokens.o200k_base");

function tokenizer() {
  const owner = globalThis as typeof globalThis & { [TOKENIZER_KEY]?: Tiktoken };
  return owner[TOKENIZER_KEY] ??= new Tiktoken(o200kBase);
}

const Gpt5TextTokens = Object.freeze({
  encoding: "o200k_base" as const,

  count(text: string) {
    return tokenizer().encode(text, [], []).length;
  },

  supports(model: string) {
    return model === "gpt-5" || model.startsWith("gpt-5.") || model.startsWith("gpt-5-");
  },
});

export default Gpt5TextTokens;
