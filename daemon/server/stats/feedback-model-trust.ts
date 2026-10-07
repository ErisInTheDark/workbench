/*
 * Exports:
 * - FeedbackEffort: reasoning effort levels the registry scores.
 * - FeedbackModelTrust: one model's best score, measured per-effort scores, and tuned category multipliers.
 * - FEEDBACK_MODEL_TRUST: hand-maintained trust registry for agent feedback authors.
 */
import type { WorkbenchFeedbackCategory } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";

export type FeedbackEffort = "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

export interface FeedbackModelTrust {
  aliases: readonly string[];
  /** How far this model's reports deserve trust per category, tuned from feedback; missing means 1. */
  categories: Readonly<Partial<Record<WorkbenchFeedbackCategory, number>>>;
  /** Measured score per effort on the same scale as `score`; missing efforts use the generic curve. */
  efforts: Readonly<Partial<Record<FeedbackEffort, number>>>;
  model: string;
  /** Best measured score at any effort. */
  score: number;
}

function trust(
  model: string,
  score: number,
  efforts: FeedbackModelTrust["efforts"] = {},
  options: { aliases?: readonly string[]; categories?: FeedbackModelTrust["categories"] } = {},
): FeedbackModelTrust {
  return Object.freeze({ aliases: options.aliases ?? [], categories: options.categories ?? {}, efforts, model, score });
}

export const FEEDBACK_MODEL_TRUST: readonly FeedbackModelTrust[] = Object.freeze([
  trust("claude-opus-5-5", 57.6, { xhigh: 56, high: 53.6, medium: 51.2, low: 42.3 }),
  trust("claude-sonnet-5-5", 56, { xhigh: 51.9, high: 46.8, medium: 40.8, low: 35.9 }),
  trust("claude-fable-5-1", 53.4, { xhigh: 53.2, high: 51.2, medium: 48.9, low: 46.8 }),
  trust("claude-opus-5", 50.8, { xhigh: 49.7, high: 48.1, medium: 44.8, low: 39.4 }),
  trust("claude-fable-5", 49.6),
  trust("claude-opus-4-8", 41.8),
  trust("claude-opus-4-7", 40.7, { none: 30.9 }),
  trust("claude-sonnet-5", 38.2, { xhigh: 34.4, high: 31.7, medium: 28.1, low: 24.3, none: 23.2 }),
  trust("claude-opus-4-6", 31.9, { none: 26.4 }),
  trust("claude-sonnet-4-6", 30.1, { none: 24.7 }),
  trust("claude-opus-4-5", 29.1, { none: 23.7 }),
  trust("claude-opus-4-1", 22.8, { none: 18.6 }),
  trust("claude-sonnet-4-5", 20.7, { none: 19.3 }),
  trust("claude-opus-4", 20.6, { none: 16.6 }, { aliases: ["claude-opus-4-0"] }),
  trust("claude-sonnet-4", 18.9, { none: 16.6 }, { aliases: ["claude-sonnet-4-0"] }),
  trust("claude-haiku-4-5", 16.9, { none: 15.4 }),
  trust("claude-3-5-haiku", 8.9, {}, { aliases: ["claude-haiku-3-5"] }),

  trust("gpt-6-astra", 52.7, { xhigh: 52.4, high: 50.9, medium: 49.6, low: 45.8 }),
  trust("gpt-6.1-sol", 51.8, { xhigh: 51, high: 50.2, medium: 47.8, low: 42.1 }),
  trust("gpt-6-sol", 47.6, { xhigh: 44.2, high: 42.4, medium: 39.8, low: 34.2, none: 28.5 }),
  trust("gpt-5.6-sol", 47, { xhigh: 44, high: 42.3, medium: 39.2, low: 33.5, none: 28.3 }),
  trust("gpt-5.6-terra", 42.1, { xhigh: 38, high: 34.2, medium: 30.1, low: 27.5, none: 20.8 }),
  trust("gpt-5.4", 39, { xhigh: 39, low: 27.6, none: 18.2 }),
  trust("gpt-5.5", 38.4, { xhigh: 38.4, high: 37, medium: 33.8, low: 30.7, none: 23.2 }),
  trust("gpt-6-luna", 38.1, { xhigh: 34.6, high: 32.9, medium: 29.9, low: 21.5, none: 18.5 }),
  trust("gpt-5.6-luna", 37.3, { xhigh: 34.6, high: 32.1, medium: 25, low: 21, none: 15.5 }),
  trust("gpt-5.3-codex", 32.5, { xhigh: 32.5 }),
  trust("gpt-5.2", 30.4, { xhigh: 30.4, medium: 26.5, none: 17 }),
  trust("gpt-5.2-codex", 28.5, { xhigh: 28.5 }),
  trust("gpt-5-codex", 24.9, { high: 24.9 }),
  trust("gpt-5.1", 24.7, { high: 24.7, none: 13.3 }),
  trust("gpt-5.4-mini", 24.1, { xhigh: 24.1, medium: 19.7, none: 11.1 }),
  trust("gpt-5.1-codex", 23.7, { high: 23.7 }),
  trust("gpt-5", 23, { high: 23, medium: 22.9, low: 20.8, minimal: 11.4 }),
  trust("o3-pro", 21.9),
  trust("gpt-5.4-nano", 20.7, { xhigh: 20.7, medium: 20, none: 11.7 }),
  trust("gpt-5-mini", 20.6, { high: 16.8, medium: 20.6, minimal: 9.9 }),
  trust("gpt-5.1-codex-mini", 20.4, { high: 20.4 }),
  trust("o3", 20.2),
  trust("o4-mini", 16.7),
  trust("o1", 15.2),
  trust("gpt-5-nano", 13, { high: 13, medium: 12.5, minimal: 7.1 }),
  trust("gpt-4.1", 12.7),
  trust("o3-mini", 12.5),
  trust("o1-pro", 12.4),
  trust("gpt-4.1-mini", 10.2),
  trust("o1-mini", 9.8),
  trust("gpt-4.5-preview", 9.6),
  trust("gpt-4o", 8.4),
  trust("gpt-4.1-nano", 7.8),
  trust("gpt-4-turbo", 7),
  trust("gpt-4o-mini", 6.7),
  trust("gpt-4", 6.7),
  trust("gpt-3.5-turbo", 5.5),

  trust("muse-spark-1.3", 48.1, { xhigh: 45.1 }, { aliases: ["muse-spark-1.3-contributor"] }),
  trust("grok-4.7", 46.4, { xhigh: 46.4, high: 46.3, low: 42.2 }),
  trust("mimo-v2.6-pro", 46.3),
  trust("qwen3.8-max", 45.4),
  trust("glm-5.3", 44.8, { low: 34.3 }),
  trust("grok-4.6", 44.3, { xhigh: 44.2, high: 44.3, medium: 42.8, low: 35.1 }),
  trust("kimi-k3", 43.6, { low: 30.1 }),
  trust("glm-5.3-flash", 41.8),
  trust("gemini-3.8-flash", 40.9, { high: 40.9, medium: 39.8, low: 33.5 }),
  trust("gemini-3.7-flash", 39.6, { high: 39.1, medium: 39.6, low: 36.9 }),
  trust("muse-spark-1.2", 39.6, { xhigh: 39.6 }, { aliases: ["muse-spark-1.2-contributor"] }),
  trust("deepseek-v4.1-flash", 39.5, { none: 24.7 }),
  trust("grok-4.5", 38.8, { high: 38.8 }),
  trust("mimo-v2.6-flash", 37.9),
  trust("deepseek-v4-pro", 36, { none: 20.4 }),
  trust("deepseek-v4-flash-vision-exp", 34.8),
  trust("deepseek-v4-flash", 34.3),
  trust("gemini-3.6-flash", 34, { high: 34 }),
  trust("glm-5.2", 33.7, { none: 22.4 }),
  trust("gemini-3.5-flash", 33.6, { high: 32.6, medium: 33.6, minimal: 23.8 }),
  trust("gemini-3.1-pro", 29.7, {}, { aliases: ["gemini-3.1-pro-preview"] }),
  trust("qwen3.7-max", 29.5),
  trust("minimax-m3", 29.2),
  trust("glm-5", 27.9, { none: 21.8 }),
  trust("grok-build-0.1", 27.2),
  trust("kimi-k2.6", 27, { none: 23.6 }),
  trust("qwen3.6-plus", 27),
  trust("gemini-3-flash", 26.3, { none: 17.9 }, { aliases: ["gemini-3-flash-preview"] }),
  trust("glm-5.1", 26.1, { none: 24.2 }),
  trust("mimo-v2.5-pro", 26, { none: 18.3 }),
  trust("kimi-k2.7-code", 25.8),
  trust("hy3", 25.3),
  trust("mimo-v2.5", 25.2),
  trust("qwen3.7-plus", 25.2),
  trust("kimi-k2.5", 23.5, { none: 19.4 }),
  trust("minimax-m2.7", 22.8),
  trust("minimax-m2.5", 22.8),
  trust("gemini-3.5-flash-lite", 22.2),
  trust("longcat-2.0", 19.1),
]);
