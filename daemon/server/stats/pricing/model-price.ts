/*
 * Exports:
 * - TokenRates: USD per 1M tokens for each billable category.
 * - ModelPrice: one catalogue entry with optional context tier, fast multiplier, and peak window.
 * - PriceCatalogue: normalised model id lookup for one billing source.
 * - rates: build TokenRates; cache writes default to the uncached input rate.
 * - scaleRates: multiply rates per category.
 * - createPriceCatalogue: index entries and their aliases by normalised id.
 * - normalizePricedModelId: strip snapshot dates and Claude context suffixes before lookup.
 */

export interface TokenRates {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export interface ModelPrice {
  id: string;
  aliases?: readonly string[];
  standard: TokenRates;
  /** Rates for the full request once total input exceeds the threshold. */
  long?: { aboveInputTokens: number; rates: TokenRates };
  /** Applies to every applicable rate when the service tier is fast or priority. */
  fastMultiplier?: number;
  /** Replaces standard (and long) rates while the predicate reports peak time. */
  peak?: { rates: TokenRates; isPeak(occurredAt: number): boolean };
}

export interface PriceCatalogue {
  name: string;
  find(modelId: string): ModelPrice | null;
}

export function rates(input: number, cachedInput: number, output: number, cacheWrite = input): TokenRates {
  return { input, cachedInput, cacheWrite, output };
}

export function scaleRates(value: TokenRates, multipliers: { input: number; output: number }): TokenRates {
  return {
    input: value.input * multipliers.input,
    cachedInput: value.cachedInput * multipliers.input,
    cacheWrite: value.cacheWrite * multipliers.input,
    output: value.output * multipliers.output,
  };
}

export function normalizePricedModelId(model: string) {
  return model.trim().toLowerCase()
    .replace(/\[[^\]]*\]$/u, "")
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/u, "");
}

export function createPriceCatalogue(name: string, entries: readonly ModelPrice[]): PriceCatalogue {
  const byId = new Map<string, ModelPrice>();
  for (const entry of entries) {
    for (const id of [entry.id, ...entry.aliases ?? []]) {
      const key = normalizePricedModelId(id);
      if (byId.has(key)) throw new Error(`Duplicate ${name} price for ${key}.`);
      byId.set(key, entry);
    }
  }
  return { name, find: (modelId) => byId.get(normalizePricedModelId(modelId)) ?? null };
}
