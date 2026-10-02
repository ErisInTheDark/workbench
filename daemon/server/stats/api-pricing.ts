/*
 * Exports:
 * - API_PRICING_CATALOG_DATE/API_PRICING_POLICY_VERSION: dated estimate policy identity.
 * - ApiPricingModelSource: estimate attribution confidence.
 * - ApiCostEstimate: priced categories for one usage fact.
 * - resolveModelPrice: route a provider model to its billing catalogue entry, or null when unpriced.
 * - estimateApiTokenCost: estimate API-equivalent token cost, or null when the model has no catalogue price.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { ANTHROPIC_PRICES } from "./pricing/anthropic-prices.ts";
import { scaleRates, type ModelPrice, type PriceCatalogue, type TokenRates } from "./pricing/model-price.ts";
import { OPENAI_PRICES } from "./pricing/openai-prices.ts";
import { OPENCODE_GO_PRICES } from "./pricing/opencode-go-prices.ts";
import { OPENCODE_ZEN_PRICES } from "./pricing/opencode-zen-prices.ts";

export const API_PRICING_CATALOG_DATE = "2026-10-01";
export const API_PRICING_POLICY_VERSION = 2;
export type ApiPricingModelSource = "exact" | "inferred";

export interface ApiCostEstimate {
  byTokenType: { input: number; cacheRead: number; cacheWrite: number; output: number };
  catalogue: string;
  model: string;
  source: ApiPricingModelSource;
  totalUsd: number;
}

interface TokenCostInput {
  cacheWriteInputTokens: number;
  cachedInputTokens: number;
  inputTokens: number;
  model: string | null;
  modelSource?: ApiPricingModelSource;
  occurredAt?: number;
  outputTokens: number;
  provider: WorkbenchHarness;
  serviceTier: string | null;
}

/** Namespaced ids (`provider/model`) name their billing source; bare ids bill through the harness's own API. */
const NAMESPACE_CATALOGUES: Readonly<Record<string, PriceCatalogue>> = {
  anthropic: ANTHROPIC_PRICES,
  openai: OPENAI_PRICES,
  opencode: OPENCODE_ZEN_PRICES,
  "opencode-go": OPENCODE_GO_PRICES,
};
const HARNESS_CATALOGUES: Partial<Record<WorkbenchHarness, PriceCatalogue>> = {
  claude: ANTHROPIC_PRICES,
  codex: OPENAI_PRICES,
};

export function resolveModelPrice(provider: WorkbenchHarness, model: string | null): { catalogue: PriceCatalogue; price: ModelPrice } | null {
  const requested = model?.trim();
  if (!requested) return null;
  const slash = requested.indexOf("/");
  const catalogue = slash > 0
    ? NAMESPACE_CATALOGUES[requested.slice(0, slash).toLowerCase()]
    : HARNESS_CATALOGUES[provider];
  const price = catalogue?.find(slash > 0 ? requested.slice(slash + 1) : requested) ?? null;
  return catalogue && price ? { catalogue, price } : null;
}

function safeTokens(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function applicableRates(price: ModelPrice, inputTokens: number, serviceTier: string | null, occurredAt: number | undefined): TokenRates {
  let selected = price.long && inputTokens > price.long.aboveInputTokens ? price.long.rates : price.standard;
  if (price.peak && occurredAt !== undefined && price.peak.isPeak(occurredAt)) selected = price.peak.rates;
  const fast = serviceTier === "fast" || serviceTier === "priority";
  return fast && price.fastMultiplier
    ? scaleRates(selected, { input: price.fastMultiplier, output: price.fastMultiplier })
    : selected;
}

const usd = (tokens: number, ratePerMillion: number) => tokens * ratePerMillion / 1_000_000;
const rounded = (value: number) => Number(value.toFixed(8));

export function estimateApiTokenCost(input: TokenCostInput): ApiCostEstimate | null {
  const resolved = resolveModelPrice(input.provider, input.model);
  if (!resolved) return null;
  const counts = {
    cacheWrite: safeTokens(input.cacheWriteInputTokens),
    cached: safeTokens(input.cachedInputTokens),
    input: safeTokens(input.inputTokens),
    output: safeTokens(input.outputTokens),
  };
  const selected = applicableRates(resolved.price, counts.input, input.serviceTier, input.occurredAt);
  const uncachedInput = Math.max(0, counts.input - counts.cached - counts.cacheWrite);
  const byTokenType = {
    input: rounded(usd(uncachedInput, selected.input)),
    cacheRead: rounded(usd(counts.cached, selected.cachedInput)),
    cacheWrite: rounded(usd(counts.cacheWrite, selected.cacheWrite)),
    output: rounded(usd(counts.output, selected.output)),
  };
  return {
    byTokenType,
    catalogue: resolved.catalogue.name,
    model: resolved.price.id,
    source: input.modelSource ?? "exact",
    totalUsd: rounded(byTokenType.input + byTokenType.cacheRead + byTokenType.cacheWrite + byTokenType.output),
  };
}
