/* No production exports. Mounted tests protect where an opened feedback card addresses its report: this thread by default, a new thread while Shift is held. */
import "../../../workbench/testing/jsdom-environment";

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";
import { WorkbenchFeedbackAddressingContext, type WorkbenchFeedbackAddressing } from "../address-feedback-context";
import { createFakeStatsWorkspace, TEST_STATS_THREAD_LOCATION, testFeedbackItem, testFeedbackReportSection } from "../stats/stats-test-store";
import { WorkbenchStatsProvider } from "../stats/use-stats";
import WorkbenchStatsStore from "../stats/WorkbenchStatsStore";
import ThreadFeedbackCommandItem from "./ThreadFeedbackCommandItem";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.getAnimations ??= () => [];

/** Report #53 on thread-one, published before mounting so the card opens onto it. */
function statsWithProjectReport() {
  const { open, workspace } = createFakeStatsWorkspace(new Map([["thread-one", TEST_STATS_THREAD_LOCATION]]));
  const stats = new WorkbenchStatsStore(workspace);
  stats.subscribeFeedbackReport({ feedbackId: 53, threadId: "thread-one" }, () => {});
  for (const query of open.values()) query.publish(testFeedbackReportSection(testFeedbackItem({ channel: "project" })));
  return stats;
}

test("address goes to this thread, and to a new thread in the report's project while Shift is held", async () => {
  const here: WorkbenchThreadAddressedFeedback[] = [];
  const elsewhere: Array<{ projectId: string; ids: number[] }> = [];
  const addressing: WorkbenchFeedbackAddressing = {
    here: report => { here.push(report); },
    inNewThread: (projectId, reports) => { elsewhere.push({ projectId, ids: reports.map(({ id }) => id) }); },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const address = () => [...container.querySelectorAll("button")].find(button => /^Address/u.test(button.textContent ?? ""))!;
  try {
    await act(async () => {
      root.render(createElement(WorkbenchStatsProvider, { value: statsWithProjectReport() },
        createElement(WorkbenchFeedbackAddressingContext.Provider, { value: addressing },
          createElement(ThreadFeedbackCommandItem, {
            defaultOpen: true, durationMs: 12, feedbackId: 53, outcome: "completed", projectId: "project-one", threadId: "thread-one",
            operation: { category: "bug", channel: "project", report: "Filed text.", title: "Filed title" },
          }))));
    });
    assert.equal(address().textContent, "Address here");
    await act(async () => { address().click(); });
    assert.deepEqual(here.map(({ id, kind }) => ({ id, kind })), [{ id: 53, kind: "feedback" }]);

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })); });
    assert.equal(address().textContent, "Address in new thread");
    await act(async () => { address().click(); });
    assert.deepEqual(elsewhere, [{ projectId: "project-one", ids: [53] }]);
    assert.equal(here.length, 1);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
