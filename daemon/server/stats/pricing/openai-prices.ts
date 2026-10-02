/*
 * Exports:
 * - OPENAI_PRICES: OpenAI API text-model rates from developers.openai.com model pages (checked 2026-10-01).
 */
import { createPriceCatalogue, rates, scaleRates, type ModelPrice, type TokenRates } from "./model-price.ts";

/** OpenAI bills prompts above 272K input tokens at 2x input/cache and 1.5x output for the full request. */
function longContext(standard: TokenRates): ModelPrice["long"] {
  return { aboveInputTokens: 272_000, rates: scaleRates(standard, { input: 2, output: 1.5 }) };
}

function price(
  id: string,
  standard: TokenRates,
  options: { aliases?: readonly string[]; long?: boolean; fast?: number } = {},
): ModelPrice {
  return {
    id,
    standard,
    ...(options.aliases ? { aliases: options.aliases } : {}),
    ...(options.long ? { long: longContext(standard) } : {}),
    ...(options.fast ? { fastMultiplier: options.fast } : {}),
  };
}

export const OPENAI_PRICES = createPriceCatalogue("OpenAI", [
  price("gpt-6-astra", rates(10, 1, 50, 12.5), { long: true, fast: 2 }),
  price("gpt-6.1-sol", rates(2, 0.1, 10, 2.5), { long: true, fast: 2 }),
  price("gpt-6-sol", rates(2, 0.2, 10, 2.5), { long: true, fast: 2 }),
  price("gpt-6-luna", rates(0.1, 0.01, 0.5, 0.125), { long: true, fast: 2 }),
  price("gpt-5.6-sol", rates(4, 0.4, 20, 5), { aliases: ["gpt-5.6", "daybreak-blue"], long: true, fast: 2 }),
  price("gpt-5.6-terra", rates(2, 0.2, 12, 2.5), { long: true, fast: 2 }),
  price("gpt-5.6-luna", rates(0.2, 0.02, 1.2, 0.25), { long: true, fast: 2 }),
  price("gpt-5.6-cyber", rates(12.5, 1.25, 75, 15.625), { aliases: ["daybreak-red"] }),
  price("gpt-5.5", rates(5, 0.5, 30), { long: true, fast: 2.5 }),
  price("gpt-5.5-pro", rates(30, 30, 180)),
  price("gpt-5.4", rates(2.5, 0.25, 15), { long: true, fast: 2 }),
  price("gpt-5.4-pro", rates(30, 30, 180), { long: true }),
  price("gpt-5.4-mini", rates(0.75, 0.075, 4.5), { fast: 2 }),
  price("gpt-5.4-nano", rates(0.2, 0.02, 1.25)),
  price("gpt-5.3-codex", rates(1.75, 0.175, 14), { fast: 2 }),
  price("gpt-5.2", rates(1.75, 0.175, 14), { fast: 2 }),
  price("gpt-5.2-pro", rates(21, 21, 168)),
  price("gpt-5.2-codex", rates(1.75, 0.175, 14)),
  price("gpt-5.1", rates(1.25, 0.125, 10)),
  price("gpt-5.1-codex", rates(1.25, 0.125, 10)),
  price("gpt-5.1-codex-max", rates(1.25, 0.125, 10)),
  price("gpt-5.1-codex-mini", rates(0.25, 0.025, 2)),
  price("gpt-5", rates(1.25, 0.125, 10)),
  price("gpt-5-codex", rates(1.25, 0.125, 10)),
  price("gpt-5-mini", rates(0.25, 0.025, 2)),
  price("gpt-5-nano", rates(0.05, 0.005, 0.4)),
  price("gpt-5-pro", rates(15, 15, 120)),
  price("codex-mini-latest", rates(1.5, 0.375, 6)),
  price("chat-latest", rates(5, 0.5, 30)),
  price("o3-pro", rates(20, 20, 80)),
  price("o3", rates(2, 0.5, 8)),
  price("o3-mini", rates(1.1, 0.55, 4.4)),
  price("o4-mini", rates(1.1, 0.275, 4.4)),
  price("o1", rates(15, 7.5, 60)),
  price("o1-mini", rates(1.1, 0.55, 4.4)),
  price("o1-pro", rates(150, 150, 600)),
  price("gpt-4.5-preview", rates(75, 37.5, 150)),
  price("gpt-4.1", rates(2, 0.5, 8)),
  price("gpt-4.1-mini", rates(0.4, 0.1, 1.6)),
  price("gpt-4.1-nano", rates(0.1, 0.025, 0.4)),
  price("gpt-4o", rates(2.5, 1.25, 10)),
  price("gpt-4o-mini", rates(0.15, 0.075, 0.6)),
  price("gpt-4-turbo", rates(10, 10, 30)),
  price("gpt-4", rates(30, 30, 60)),
  price("gpt-3.5-turbo", rates(0.5, 0.5, 1.5)),
]);
