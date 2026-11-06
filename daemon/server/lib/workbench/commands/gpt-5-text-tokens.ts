/*
 * Exports:
 * - Gpt5TokenMeasure: a token count, and whether splitting long runs made it an estimate.
 * - default Gpt5TextTokens: recognize GPT-5 model identifiers and count plain text with their o200k_base encoding, splitting the long unbroken
 *   runs the tokenizer handles quadratically. Keywords: GPT-5, tokens, o200k_base, tiktoken.
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

/** One tokenizer regex piece is merged quadratically, and only runs of one class get long: lowercase, CJK without spaces, `-----`. */
const LONG_RUN = /[\p{L}\p{M}]{65,}|[^\s\p{L}\p{N}]{65,}/gu;
const LONG_RUN_CHUNK_CHARS = 64;

export interface Gpt5TokenMeasure {
  estimated: boolean;
  tokens: number;
}

function measure(text: string): Gpt5TokenMeasure {
  const encode = (part: string) => tokenizer().encode(part, [], []).length;
  const chunks = new Map<string, number>();
  let tokens = 0;
  let end = 0;
  let estimated = false;
  for (const match of text.matchAll(LONG_RUN)) {
    estimated = true;
    if (match.index > end) tokens += encode(text.slice(end, match.index));
    for (let start = 0; start < match[0].length; start += LONG_RUN_CHUNK_CHARS) {
      const chunk = match[0].slice(start, start + LONG_RUN_CHUNK_CHARS);
      let count = chunks.get(chunk);
      if (count === undefined) chunks.set(chunk, count = encode(chunk));
      tokens += count;
    }
    end = match.index + match[0].length;
  }
  if (end < text.length || !text.length) tokens += encode(text.slice(end));
  return { estimated, tokens };
}

const Gpt5TextTokens = Object.freeze({
  encoding: "o200k_base" as const,

  count(text: string) {
    return measure(text).tokens;
  },

  /** Characters inside long runs: the cheap signal for how slow `measure` may be. */
  longRunChars(text: string) {
    let chars = 0;
    for (const match of text.matchAll(LONG_RUN)) chars += match[0].length;
    return chars;
  },

  measure,

  supports(model: string) {
    return model === "gpt-5" || model.startsWith("gpt-5.") || model.startsWith("gpt-5-");
  },
});

export default Gpt5TextTokens;
