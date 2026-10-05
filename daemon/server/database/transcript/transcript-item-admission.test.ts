/* No exports. Tests protect missing-item placement without granting evidence authority to reorder admitted items. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { planTranscriptItemAdmissions } from "./transcript-item-admission.ts";

for (const scenario of [
  { admitted: [], evidence: ["first", "second"], expected: ["first", "second"] },
  { admitted: ["after"], evidence: ["first", "second", "after"], expected: ["first", "second", "after"] },
  { admitted: ["before", "after"], evidence: ["before", "first", "second", "after"], expected: ["before", "first", "second", "after"] },
  { admitted: ["before", "compaction", "after"], evidence: ["before", "missing", "after"], expected: ["before", "compaction", "after", "missing"] },
  { admitted: ["first", "second"], evidence: ["second", "missing", "first"], expected: ["first", "second", "missing"] },
  { admitted: ["first", "second"], evidence: ["first", "last", "last"], expected: ["first", "second", "last"] },
]) {
  test(`admission preserves canonical order for ${scenario.admitted.join(",")} from ${scenario.evidence.join(",")}`, () => {
    const result = [...scenario.admitted];
    for (const admission of planTranscriptItemAdmissions(result, scenario.evidence)) {
      assert.ok(!scenario.admitted.includes(admission.itemId));
      const index = admission.beforeItemId === null ? result.length : result.indexOf(admission.beforeItemId);
      assert.ok(index >= 0);
      result.splice(index, 0, admission.itemId);
    }
    assert.deepEqual(result, scenario.expected);
    assert.deepEqual(result.filter(id => scenario.admitted.includes(id)), scenario.admitted);
    assert.deepEqual(planTranscriptItemAdmissions(result, scenario.evidence), []);
  });
}
