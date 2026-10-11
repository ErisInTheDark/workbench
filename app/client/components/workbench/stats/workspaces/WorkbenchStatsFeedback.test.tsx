/* No production exports. Protect the stats feedback view defaulting to unowned reports. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";

import { EMPTY_WORKBENCH_STATS_SECTIONS } from "workbench-shared/workbench/stats/workbench-stats-conformance";
import { renderWithStats, testFeedbackItem, testStatsScope } from "../stats-test-store";
import WorkbenchStatsFeedback from "./WorkbenchStatsFeedback";

test("feedback defaults to unowned reports and offers the all-reports view", () => {
  const unowned = testFeedbackItem({ id: 1, owned: false, title: "Unowned report" });
  const owned = testFeedbackItem({ id: 2, owned: true, title: "Owned report" });
  const html = renderWithStats(createElement(WorkbenchStatsFeedback), {
    feedback: {
      ...EMPTY_WORKBENCH_STATS_SECTIONS.feedback,
      feedback: {
        counts: [{ category: "bug", count: 2 }],
        items: [unowned, owned],
        ownership: [],
        total: 2,
        workbenchProjectId: null,
      },
      generatedAt: 1,
    },
  }, { scope: testStatsScope({ attachedDaemonId: null }) });

  assert.match(html, /Unowned report/u);
  assert.doesNotMatch(html, /Owned report/u);
  assert.match(html, />Unowned</u);
  assert.match(html, />All</u);
});
