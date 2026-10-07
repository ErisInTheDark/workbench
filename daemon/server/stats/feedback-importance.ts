/*
 * Exports:
 * - FeedbackImportanceInput/FeedbackImportance: one report's author facts and its computed weight.
 * - createFeedbackImportanceScorer: score reports against one trust registry.
 * - scoreFeedbackImportance: score reports against the maintained Workbench registry.
 */
import type { WorkbenchFeedbackCategory } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { FEEDBACK_MODEL_TRUST, type FeedbackEffort, type FeedbackModelTrust } from "./feedback-model-trust.ts";

export interface FeedbackImportanceInput {
  category: WorkbenchFeedbackCategory;
  model: string | null;
  reasoningEffort: string | null;
}

export interface FeedbackImportance {
  /** 0 to 1. */
  importance: number;
  /** False when the model is not in the registry and scored at the registry median. */
  scored: boolean;
}

// Typical measured share of a model's best score at each effort, for models without their own measurement.
const GENERIC_EFFORT_RATIO: Readonly<Record<FeedbackEffort, number>> = {
  max: 1, xhigh: 0.94, high: 0.89, medium: 0.82, low: 0.68, minimal: 0.5, none: 0.55,
};
// An unrecorded effort is the provider default, usually medium or high.
const UNKNOWN_EFFORT_RATIO = 0.86;
// Confusion from weak or low-effort runs is expected, so it falls away faster than other categories.
const CATEGORY_SHARPNESS: Readonly<Record<WorkbenchFeedbackCategory, number>> = { bug: 1, waste: 1, confusion: 2, opportunity: 1 };

/** Provider ids carry namespaces, release dates, and context-window suffixes the registry omits. */
function modelKey(model: string) {
  return model.trim().toLowerCase().replace(/^.*\//u, "").replace(/\[[^\]]*\]$/u, "").replace(/-\d{8}$/u, "");
}

function effortKey(effort: string | null): FeedbackEffort | null {
  const key = effort?.trim().toLowerCase() ?? "";
  return Object.hasOwn(GENERIC_EFFORT_RATIO, key) ? key as FeedbackEffort : null;
}

export function createFeedbackImportanceScorer(registry: readonly FeedbackModelTrust[]) {
  const models = new Map(registry.flatMap((entry) => [entry.model, ...entry.aliases].map((key) => [modelKey(key), entry] as const)));
  const scores = registry.map(({ score }) => score).sort((left, right) => left - right);
  const best = scores.at(-1) ?? 1;
  const middle = scores.length / 2;
  const median = scores.length ? (scores[Math.floor(middle)]! + scores[Math.ceil(middle) - 1]!) / 2 : best / 2;
  return ({ category, model, reasoningEffort }: FeedbackImportanceInput): FeedbackImportance => {
    const entry = model ? models.get(modelKey(model)) ?? null : null;
    const effort = effortKey(reasoningEffort);
    const measured = effort ? entry?.efforts[effort] : undefined;
    const effortRatio = !effort ? UNKNOWN_EFFORT_RATIO
      : measured !== undefined && entry ? measured / entry.score
        : GENERIC_EFFORT_RATIO[effort];
    const capability = ((entry?.score ?? median) / best) * effortRatio * (entry?.categories[category] ?? 1);
    return { importance: Math.min(1, Math.max(0, capability)) ** CATEGORY_SHARPNESS[category], scored: entry !== null };
  };
}

export const scoreFeedbackImportance = createFeedbackImportanceScorer(FEEDBACK_MODEL_TRUST);
