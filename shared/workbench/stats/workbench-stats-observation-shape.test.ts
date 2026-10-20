/* No exports. Protect stats observations shipping only what changed across the daemon and app hops. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { applyObservationDelta, diffObservationValue } from "../workspace/observation-patch.ts";
import { daemonObservationShape, workspaceObservationShape } from "../workspace/workspace-observation.ts";

const HOUR = 3_600_000;
const window = { durationMinutes: 300, resetsAt: null, usedPercent: 10 };

function limitsObservation(sampleCount: number, generatedAt: number) {
  return {
    subscriptionId: randomUUID(), generation: 1, revision: 1, kind: "stats" as const,
    phase: "current" as const, failure: null, refinement: "current" as const,
    data: {
      section: "limits" as const, generatedAt,
      rateLimits: [{
        account: null, harness: "codex", limitId: "codex", limitName: null,
        samples: Array.from({ length: sampleCount }, (_, index) => ({
          observedAt: index * HOUR, primary: window, secondary: null, tertiary: null,
        })),
      }],
    },
  };
}

const hops = [
  ["daemon", daemonObservationShape("stats")],
  ["app", workspaceObservationShape("stats")],
] as const;

for (const [hop, shape] of hops) {
  test(`${hop} hop: one new limit sample ships about one sample and applies back to the reread`, () => {
    const before = limitsObservation(500, 1_000);
    const after = limitsObservation(501, 2_000);
    after.subscriptionId = before.subscriptionId;
    const delta = diffObservationValue(before, after, shape);
    assert.ok(delta);
    assert.deepEqual(applyObservationDelta(before, delta, shape), after);
    const sample = JSON.stringify(after.data.rateLimits[0]!.samples.at(-1));
    assert.ok(JSON.stringify(delta).length < sample.length * 4, "the delta carries the new sample, not the whole history");
  });

  test(`${hop} hop: a reread whose only change is its generation time publishes nothing`, () => {
    const before = limitsObservation(50, 1_000);
    const after = { ...limitsObservation(50, 2_000), subscriptionId: before.subscriptionId };
    assert.ok(diffObservationValue(before, after, shape) === null, "an unchanged section diffs to nothing");
  });
}
