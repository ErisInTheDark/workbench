/*
 * Exports:
 * - default Gpt5TextTokens: recognize GPT-5 model identifiers and count plain text with their o200k_base encoding. Keywords: GPT-5, tokens, o200k_base, tiktoken.
 */
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

const tokenizer = new Tiktoken(o200kBase);

const Gpt5TextTokens = Object.freeze({
  encoding: "o200k_base" as const,

  count(text: string) {
    return tokenizer.encode(text, [], []).length;
  },

  supports(model: string) {
    return model === "gpt-5" || model.startsWith("gpt-5.") || model.startsWith("gpt-5-");
  },
});

export default Gpt5TextTokens;
