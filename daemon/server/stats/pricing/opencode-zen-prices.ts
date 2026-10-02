/*
 * Exports:
 * - OPENCODE_ZEN_PRICES: OpenCode Zen pay-as-you-go rates for `opencode/<model>` (opencode.ai/docs/zen, checked 2026-10-01).
 */
import { createPriceCatalogue, rates, type ModelPrice, type TokenRates } from "./model-price.ts";

const FREE = rates(0, 0, 0);

/** Zen columns are input, output, cached read, cached write; a missing write price bills writes as input. */
function zen(input: number, output: number, cachedRead: number, cachedWrite?: number) {
  return rates(input, cachedRead, output, cachedWrite ?? input);
}

function price(id: string, standard: TokenRates, long?: { above: number; rates: TokenRates }): ModelPrice {
  return { id, standard, ...(long ? { long: { aboveInputTokens: long.above, rates: long.rates } } : {}) };
}

export const OPENCODE_ZEN_PRICES = createPriceCatalogue("OpenCode Zen", [
  ...["big-pickle", "space-bunny-free", "longcat-2.5-preview-free", "mimo-v2.6-flash-free", "mimo-v2.5-free",
    "ling-3.0-flash-fin-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free",
    "muse-spark-1.3-contributor-free", "jev-1.13-free"].map((id) => price(id, FREE)),
  price("jev-1.13", zen(0.042, 0, 0.042)),
  price("minimax-m3", zen(0.3, 1.2, 0.06)),
  price("minimax-m2.7", zen(0.3, 1.2, 0.06)),
  price("minimax-m2.5", zen(0.3, 1.2, 0.06)),
  price("glm-5.3-flash", zen(0.15, 0.5, 0.03)),
  price("glm-5.3", zen(1.4, 4.4, 0.26)),
  price("glm-5.2", zen(1.4, 4.4, 0.26)),
  price("glm-5.1", zen(1.4, 4.4, 0.26)),
  price("glm-5", zen(1, 3.2, 0.2)),
  price("kimi-k2.7-code", zen(0.95, 4, 0.19)),
  price("kimi-k3", zen(3, 15, 0.3)),
  price("kimi-k2.6", zen(0.95, 4, 0.16)),
  price("kimi-k2.5", zen(0.6, 3, 0.1)),
  price("qwen3.8-max", zen(2, 6, 0.25, 2.5)),
  price("qwen3.8-flash", zen(0.15, 0.47, 0.016, 0.2)),
  price("qwen3.7-max", zen(2.5, 7.5, 0.5, 3.125)),
  price("qwen3.7-plus", zen(0.4, 1.6, 0.04, 0.5)),
  price("qwen3.6-plus", zen(0.5, 3, 0.05, 0.625)),
  price("qwen3.5-plus", zen(0.2, 1.2, 0.02, 0.25)),
  price("deepseek-v4.1-flash", zen(0.3, 1.2, 0.006)),
  price("deepseek-v4-pro", zen(1.74, 3.48, 0.145)),
  price("deepseek-v4-flash", zen(0.14, 0.28, 0.028)),
  price("deepseek-v4-flash-vision-exp", zen(0.14, 0.28, 0.028)),
  price("claude-fable-5-1", zen(10, 50, 0.25, 12.5)),
  price("claude-fable-5", zen(10, 50, 1, 12.5)),
  price("claude-opus-5-5", zen(4, 20, 0.2, 5)),
  price("claude-opus-5", zen(5, 25, 0.5, 6.25)),
  price("claude-opus-4-8", zen(5, 25, 0.5, 6.25)),
  price("claude-opus-4-7", zen(5, 25, 0.5, 6.25)),
  price("claude-opus-4-6", zen(5, 25, 0.5, 6.25)),
  price("claude-opus-4-5", zen(5, 25, 0.5, 6.25)),
  price("claude-sonnet-5", zen(2, 10, 0.2, 2.5)),
  price("claude-sonnet-4-6", zen(3, 15, 0.3, 3.75)),
  price("claude-sonnet-4-5", zen(3, 15, 0.3, 3.75), { above: 200_000, rates: zen(6, 22.5, 0.6, 7.5) }),
  price("claude-haiku-4-5", zen(1, 5, 0.1, 1.25)),
  price("gemini-3.8-flash", zen(1.5, 7.5, 0.15)),
  price("gemini-3.7-flash", zen(1.5, 7.5, 0.15)),
  price("gemini-3.6-flash", zen(1.5, 7.5, 0.15)),
  price("gemini-3.5-flash", zen(1.5, 9, 0.15)),
  price("gemini-3.5-flash-lite", zen(0.3, 2.5, 0.03)),
  price("gemini-3.1-pro", zen(2, 12, 0.2), { above: 200_000, rates: zen(4, 18, 0.4) }),
  price("gemini-3-flash", zen(0.5, 3, 0.05)),
  price("grok-4.7", zen(2, 6, 0.5), { above: 200_000, rates: zen(4, 12, 1) }),
  price("grok-4.6", zen(2, 6, 0.5), { above: 200_000, rates: zen(4, 12, 1) }),
  price("grok-4.5", zen(2, 6, 0.3), { above: 200_000, rates: zen(4, 12, 0.6) }),
  price("grok-build-0.1", zen(1, 2, 0.2)),
  price("muse-spark-1.3", zen(1.25, 4.25, 0.15)),
  price("muse-spark-1.2", zen(1.25, 4.25, 0.15)),
  price("gpt-6-astra", zen(10, 50, 1, 12.5), { above: 272_000, rates: zen(20, 75, 2, 25) }),
  price("gpt-6-sol", zen(2, 10, 0.2, 2.5), { above: 272_000, rates: zen(4, 15, 0.4, 5) }),
  price("gpt-6.1-sol", zen(2, 10, 0.1, 2.5), { above: 272_000, rates: zen(4, 15, 0.2, 5) }),
  price("gpt-6-luna", zen(0.1, 0.5, 0.01, 0.125), { above: 272_000, rates: zen(0.2, 0.75, 0.02, 0.25) }),
  price("gpt-5.6-sol", zen(4, 20, 0.4, 5), { above: 272_000, rates: zen(8, 30, 0.8, 10) }),
  price("gpt-5.6-terra", zen(2, 12, 0.2, 2.5), { above: 272_000, rates: zen(4, 18, 0.4, 5) }),
  price("gpt-5.6-luna", zen(0.2, 1.2, 0.02, 0.25), { above: 272_000, rates: zen(0.4, 1.8, 0.04, 0.5) }),
  price("gpt-5.5", zen(5, 30, 0.5), { above: 272_000, rates: zen(10, 45, 1) }),
  price("gpt-5.5-pro", zen(30, 180, 30)),
  price("gpt-5.4", zen(2.5, 15, 0.25), { above: 272_000, rates: zen(5, 22.5, 0.5) }),
  price("gpt-5.4-pro", zen(30, 180, 30)),
  price("gpt-5.4-mini", zen(0.75, 4.5, 0.075)),
  price("gpt-5.4-nano", zen(0.2, 1.25, 0.02)),
  price("gpt-5.3-codex-spark", zen(1.75, 14, 0.175)),
  price("gpt-5.3-codex", zen(1.75, 14, 0.175)),
  price("gpt-5.2", zen(1.75, 14, 0.175)),
  price("gpt-5.2-codex", zen(1.75, 14, 0.175)),
  price("gpt-5.1", zen(1.07, 8.5, 0.107)),
  price("gpt-5.1-codex", zen(1.07, 8.5, 0.107)),
  price("gpt-5.1-codex-max", zen(1.25, 10, 0.125)),
  price("gpt-5.1-codex-mini", zen(0.25, 2, 0.025)),
  price("gpt-5", zen(1.07, 8.5, 0.107)),
  price("gpt-5-codex", zen(1.07, 8.5, 0.107)),
  price("gpt-5-nano", zen(0.05, 0.4, 0.005)),
]);
