/*
 * No exports. Tests protect feedback importance ordering by model, effort, category, and registry membership.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createFeedbackImportanceScorer } from "./feedback-importance.ts";
import type { FeedbackModelTrust } from "./feedback-model-trust.ts";

const entry = (model: string, score: number, rest: Partial<FeedbackModelTrust> = {}): FeedbackModelTrust => ({
  aliases: [], categories: {}, efforts: {}, model, score, ...rest,
});
const score = createFeedbackImportanceScorer([
  entry("smart", 60, { efforts: { high: 54, low: 30 } }),
  entry("middling", 40),
  entry("small", 20, { aliases: ["small-alias"] }),
  entry("tuned", 60, { categories: { waste: 0.5 } }),
]);

test("stronger models and higher measured efforts weigh more", () => {
  const bug = (model: string, reasoningEffort: string | null) => score({ category: "bug", model, reasoningEffort }).importance;
  assert.ok(bug("smart", "high") > bug("middling", "high"));
  assert.ok(bug("middling", "high") > bug("small", "high"));
  assert.ok(bug("smart", "max") > bug("smart", "high"));
  assert.equal(bug("smart", "high"), 0.9);
  assert.equal(bug("smart", "low"), 0.5);
});

test("confusion from weak runs is discounted harder than other categories", () => {
  const ratio = (model: string, reasoningEffort: string) => (
    score({ category: "confusion", model, reasoningEffort }).importance / score({ category: "bug", model, reasoningEffort }).importance
  );
  assert.ok(ratio("small", "low") < ratio("smart", "max"));
  assert.equal(ratio("smart", "max"), 1);
});

test("category multipliers scale only their own category", () => {
  const tuned = (category: "waste" | "bug") => score({ category, model: "tuned", reasoningEffort: "max" }).importance;
  assert.equal(tuned("bug"), 1);
  assert.equal(tuned("waste"), 0.5);
});

test("provider id decorations resolve to registry entries and unknown models score at the median", () => {
  const known = score({ category: "bug", model: "Anthropic/small-alias-20260101[1m]", reasoningEffort: "max" });
  assert.deepEqual(known, { importance: 20 / 60, scored: true });
  const unknown = score({ category: "bug", model: "mystery", reasoningEffort: "max" });
  assert.deepEqual(unknown, { importance: 50 / 60, scored: false });
  assert.equal(score({ category: "bug", model: null, reasoningEffort: "max" }).scored, false);
});
