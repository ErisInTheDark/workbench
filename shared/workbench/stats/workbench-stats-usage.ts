/*
 * Keywords: stats, usage, tokens, import, accounting.
 * Exports:
 * - WORKBENCH_STATS_USAGE_DATA_VERSION: current durable usage-accounting meaning. Keywords: stats, usage, version.
 * - WORKBENCH_STATS_USAGE_IMPORT_VERSION: retained usage evidence understood by the importer, independent of token accounting.
 * - WorkbenchCumulativeTokenUsage: harness-neutral cumulative provider token snapshot. Keywords: stats, tokens, cumulative.
 */
export const WORKBENCH_STATS_USAGE_DATA_VERSION = 2;
export const WORKBENCH_STATS_USAGE_IMPORT_VERSION = 3;

export interface WorkbenchCumulativeTokenUsage {
  cacheWriteInputTokens: number;
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
