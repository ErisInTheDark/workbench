/*
 * Exports:
 * - isOpenCodeGoPeak: DeepSeek peak hours on OpenCode Go (01-04 and 06-10 UTC, Monday to Friday).
 * - OPENCODE_GO_PRICES: OpenCode Go metered token rates for `opencode-go/<model>` (opencode.ai/docs/go, checked 2026-10-01).
 */
import { createPriceCatalogue, rates, type ModelPrice, type TokenRates } from "./model-price.ts";

const FREE = rates(0, 0, 0);

function go(input: number, output: number, cachedRead: number, cachedWrite?: number) {
  return rates(input, cachedRead, output, cachedWrite ?? input);
}

export function isOpenCodeGoPeak(occurredAt: number) {
  const date = new Date(occurredAt);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

function price(id: string, standard: TokenRates, options: { long?: { above: number; rates: TokenRates }; peak?: TokenRates } = {}): ModelPrice {
  return {
    id,
    standard,
    ...(options.long ? { long: { aboveInputTokens: options.long.above, rates: options.long.rates } } : {}),
    ...(options.peak ? { peak: { rates: options.peak, isPeak: isOpenCodeGoPeak } } : {}),
  };
}

export const OPENCODE_GO_PRICES = createPriceCatalogue("OpenCode Go", [
  price("longcat-2.5-preview-free", FREE),
  price("space-bunny-free", FREE),
  price("glm-5.3-flash", go(0.15, 0.5, 0.03)),
  price("glm-5.3", go(1.4, 4.4, 0.26)),
  price("glm-5.2", go(1.4, 4.4, 0.26)),
  price("kimi-k3", go(3, 15, 0.3)),
  price("kimi-k2.7-code", go(0.95, 4, 0.19)),
  price("kimi-k2.6", go(0.95, 4, 0.16)),
  price("longcat-2.0", go(0.3, 1.2, 0.006)),
  price("mimo-v2.6-flash", go(0.14, 0.28, 0.0028)),
  price("mimo-v2.6-pro", go(0.435, 0.87, 0.003625)),
  price("mimo-v2.5", go(0.14, 0.28, 0.0028)),
  price("mimo-v2.5-pro", go(0.435, 0.87, 0.003625)),
  price("minimax-m3", go(0.3, 1.2, 0.06)),
  price("minimax-m2.7", go(0.3, 1.2, 0.06, 0.375)),
  price("muse-spark-1.3-contributor", go(0.1, 0.2, 0.002)),
  price("muse-spark-1.2-contributor", go(0.1, 0.2, 0.002)),
  price("qwen3.8-max", go(2, 6, 0.25, 2.5)),
  price("qwen3.8-flash", go(0.15, 0.47, 0.016, 0.2)),
  price("qwen3.7-plus", go(0.4, 1.6, 0.04, 0.5), { long: { above: 256_000, rates: go(1.2, 4.8, 0.12, 1.5) } }),
  price("deepseek-v4.1-flash", go(0.15, 0.6, 0.003), { peak: go(0.3, 1.2, 0.006) }),
  price("deepseek-v4-pro", go(0.66, 1.98, 0.022), { peak: go(1.32, 3.96, 0.044) }),
  price("deepseek-v4-flash", go(0.15, 0.6, 0.003), { peak: go(0.3, 1.2, 0.006) }),
  price("deepseek-v4-flash-vision-exp", go(0.15, 0.6, 0.003), { peak: go(0.3, 1.2, 0.006) }),
  price("hy4-preview", go(0.834, 2.501, 0.042)),
  price("hy3", go(0.14, 0.58, 0.035)),
  price("grok-4.7", go(2, 6, 0.5), { long: { above: 200_000, rates: go(4, 12, 1) } }),
  price("grok-4.6", go(2, 6, 0.5), { long: { above: 200_000, rates: go(4, 12, 1) } }),
  price("gpt-6-luna", go(0.1, 0.5, 0.01, 0.125), { long: { above: 272_000, rates: go(0.2, 0.75, 0.02, 0.25) } }),
  price("gpt-5.6-luna", go(0.2, 1.2, 0.02, 0.25), { long: { above: 272_000, rates: go(0.4, 1.8, 0.04, 0.5) } }),
]);
