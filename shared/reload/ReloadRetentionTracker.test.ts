/* No production exports. Protect evidence-based reload-retention reporting across garbage collections. */
import assert from "node:assert/strict";
import test from "node:test";

import ReloadRetentionTracker from "./ReloadRetentionTracker.ts";

test("reports a retired target once only after it survives a later major collection", () => {
  let lastMajorCollectionAt = 0;
  const tracker = new ReloadRetentionTracker(() => lastMajorCollectionAt);
  const target = { label: "" };

  tracker.trackGeneration(4, target);
  assert.equal(target.label, "workbench reload generation 4");
  tracker.retireUnusedGenerations(new Set());

  assert.equal(tracker.completeReload(), null);
  assert.equal(tracker.completeReload(), null);
  assert.equal(tracker.completeReload(), null);

  lastMajorCollectionAt = Number.POSITIVE_INFINITY;
  const report = tracker.completeReload(["server:value: held shell (3s)"]);
  assert.match(report ?? "", /survived a later major garbage collection/u);
  assert.match(report ?? "", /module generation 4/u);
  assert.match(report ?? "", /server:value: held shell \(3s\)/u);
  assert.match(report ?? "", /wb debug heap/u);
  assert.equal(tracker.completeReload(), null, "one confirmed survivor produces one actionable report");
});
