/*
 * Exports:
 * - API_PRICING_CATALOG_DATE/API_PRICING_POLICY_VERSION: dated estimate policy identity. Keywords: stats, pricing, catalogue.
 * - ApiPricingModelSource: estimate attribution confidence. Keywords: stats, pricing, provenance.
 * - defaultApiPricingModel: resolve the deterministic provider fallback model. Keywords: stats, pricing, fallback.
 * - estimateApiTokenCost: estimate API-equivalent token cost with explicit tier and context rates. Keywords: stats, cost, tokens.
 */
import type { WorkbenchHarness } from "workbench-shared/types";

export const API_PRICING_CATALOG_DATE = "2026-09-05";
export const API_PRICING_POLICY_VERSION = 1;
export type ApiPricingModelSource = "exact" | "inferred" | "default";

interface TokenCostInput {
  cacheWriteInputTokens: number;
  cachedInputTokens: number;
  inputTokens: number;
  model: string | null;
  modelSource?: ApiPricingModelSource;
  outputTokens: number;
  provider?: WorkbenchHarness;
  serviceTier: string | null;
}

interface TokenRates {
  cachedInput: number;
  input: number;
  output: number;
}

interface ModelPrice {
  aliases: readonly RegExp[];
  cacheWriteInputMultiplier?: number;
  fast?: TokenRates;
  fastLong?: TokenRates;
  id: string;
  longContext: boolean;
  standard: TokenRates;
}

const rates = (input: number, cachedInput: number, output: number): TokenRates => ({ cachedInput, input, output });
const PRICES: readonly ModelPrice[] = [
  { aliases: [/^gpt-6(?:-astra)?(?:-\d{4}-\d{2}-\d{2})?$/u], cacheWriteInputMultiplier: 1.25, fast: rates(25, 2.5, 125), id: "gpt-6-astra", longContext: false, standard: rates(10, 1, 50) },
  { aliases: [/^gpt-5\.6(?:-sol)?(?:-\d{4}-\d{2}-\d{2})?$/u], cacheWriteInputMultiplier: 1.25, fast: rates(8, 0.8, 40), fastLong: rates(16, 1.6, 60), id: "gpt-5.6-sol", longContext: true, standard: rates(4, 0.4, 20) },
  { aliases: [/^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/u], cacheWriteInputMultiplier: 1.25, fast: rates(4, 0.4, 24), fastLong: rates(8, 0.8, 36), id: "gpt-5.6-terra", longContext: true, standard: rates(2, 0.2, 12) },
  { aliases: [/^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/u], cacheWriteInputMultiplier: 1.25, fast: rates(0.4, 0.04, 2.4), fastLong: rates(0.8, 0.08, 3.6), id: "gpt-5.6-luna", longContext: true, standard: rates(0.2, 0.02, 1.2) },
  { aliases: [/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/u], fast: rates(12.5, 1.25, 75), id: "gpt-5.5", longContext: true, standard: rates(5, 0.5, 30) },
  { aliases: [/^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/u], fast: rates(1.5, 0.15, 9), id: "gpt-5.4-mini", longContext: false, standard: rates(0.75, 0.075, 4.5) },
  { aliases: [/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/u], fast: rates(5, 0.5, 30), id: "gpt-5.4", longContext: true, standard: rates(2.5, 0.25, 15) },
  { aliases: [/^gpt-5\.3(?:-codex)?(?:-\d{4}-\d{2}-\d{2})?$/u], fast: rates(3.5, 0.35, 28), id: "gpt-5.3-codex", longContext: false, standard: rates(1.75, 0.175, 14) },
  { aliases: [/^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/u], fast: rates(3.5, 0.35, 28), id: "gpt-5.2", longContext: false, standard: rates(1.75, 0.175, 14) },
  { aliases: [/^daybreak-blue$/u], fast: rates(10, 1, 60), id: "daybreak-blue", longContext: false, standard: rates(4, 0.4, 20) },
  { aliases: [/^daybreak-red$/u], id: "daybreak-red", longContext: false, standard: rates(12.5, 1.25, 75) },
];

const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.6-sol",
  copilot: "gpt-5.6-sol",
  opencode: "gpt-5.6-sol",
} as const satisfies Record<WorkbenchHarness, string>;

export function defaultApiPricingModel(provider: WorkbenchHarness) {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

function safeTokens(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function matchPrice(model: string | null) {
  return PRICES.find(({ aliases }) => aliases.some((pattern) => pattern.test(model ?? ""))) ?? null;
}

export function estimateApiTokenCost(input: TokenCostInput) {
  const counts = {
    cacheWrite: safeTokens(input.cacheWriteInputTokens),
    cached: safeTokens(input.cachedInputTokens),
    input: safeTokens(input.inputTokens),
    output: safeTokens(input.outputTokens),
  };
  const totalTokens = counts.input + counts.output;
  const provider = input.provider ?? "codex";
  const requestedModel = input.model?.trim() || null;
  const matched = matchPrice(requestedModel);
  const price = matched ?? matchPrice(defaultApiPricingModel(provider))!;
  const source: ApiPricingModelSource = matched ? input.modelSource ?? "exact" : "default";
  const isFast = input.serviceTier === "fast" || input.serviceTier === "priority";
  const longContext = counts.input > 272_000 && price.longContext;
  const selectedRates = isFast
    ? longContext && price.fastLong
      ? price.fastLong
      : price.fast ?? price.standard
    : price.standard;
  const effectiveRates = longContext && !(isFast && price.fastLong)
    ? rates(selectedRates.input * 2, selectedRates.cachedInput * 2, selectedRates.output * 1.5)
    : selectedRates;
  const uncachedInput = Math.max(0, counts.input - counts.cached - counts.cacheWrite);
  const totalUsd = (
    uncachedInput * effectiveRates.input
    + counts.cached * effectiveRates.cachedInput
    + counts.cacheWrite * effectiveRates.input * (price.cacheWriteInputMultiplier ?? 1)
    + counts.output * effectiveRates.output
  ) / 1_000_000;
  return {
    model: price.id,
    pricedTokens: totalTokens,
    source,
    totalUsd: Number(totalUsd.toFixed(8)),
    unpricedTokens: 0,
  };
}
