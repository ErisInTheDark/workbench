/*
 * Exports:
 * - ANTHROPIC_PRICES: Claude API rates from platform.claude.com pricing (checked 2026-10-01); cache writes use the 5-minute rate.
 */
import { createPriceCatalogue, rates, scaleRates, type ModelPrice, type TokenRates } from "./model-price.ts";

function price(id: string, standard: TokenRates, options: { aliases?: readonly string[]; fast?: number; long?: boolean } = {}): ModelPrice {
  return {
    id,
    standard,
    ...(options.aliases ? { aliases: options.aliases } : {}),
    ...(options.fast ? { fastMultiplier: options.fast } : {}),
    // Claude 4.6 and later bill the full 1M window at standard rates; earlier 1M-context Sonnets did not.
    ...(options.long ? { long: { aboveInputTokens: 200_000, rates: scaleRates(standard, { input: 2, output: 1.5 }) } } : {}),
  };
}

export const ANTHROPIC_PRICES = createPriceCatalogue("Anthropic", [
  price("claude-fable-5-1", rates(10, 0.25, 50, 12.5)),
  price("claude-mythos-5-1", rates(10, 0.25, 50, 12.5)),
  price("claude-fable-5", rates(10, 1, 50, 12.5)),
  price("claude-mythos-5", rates(10, 1, 50, 12.5)),
  price("claude-opus-5-5", rates(4, 0.2, 20, 5), { fast: 2 }),
  price("claude-opus-5", rates(5, 0.5, 25, 6.25), { fast: 2 }),
  price("claude-opus-4-8", rates(5, 0.5, 25, 6.25), { fast: 2 }),
  price("claude-opus-4-7", rates(5, 0.5, 25, 6.25)),
  price("claude-opus-4-6", rates(5, 0.5, 25, 6.25)),
  price("claude-opus-4-5", rates(5, 0.5, 25, 6.25)),
  price("claude-opus-4-1", rates(15, 1.5, 75, 18.75)),
  price("claude-opus-4", rates(15, 1.5, 75, 18.75), { aliases: ["claude-opus-4-0"] }),
  price("claude-sonnet-5-5", rates(2, 0.2, 10, 2.5)),
  price("claude-sonnet-5", rates(2, 0.2, 10, 2.5)),
  price("claude-sonnet-4-6", rates(3, 0.3, 15, 3.75)),
  price("claude-sonnet-4-5", rates(3, 0.3, 15, 3.75), { long: true }),
  price("claude-sonnet-4", rates(3, 0.3, 15, 3.75), { aliases: ["claude-sonnet-4-0"], long: true }),
  price("claude-haiku-4-5", rates(1, 0.1, 5, 1.25)),
  price("claude-3-5-haiku", rates(0.8, 0.08, 4, 1), { aliases: ["claude-haiku-3-5"] }),
]);
