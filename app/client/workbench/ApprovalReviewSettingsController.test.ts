/*
 * No production exports. Tests protect reviewer settings state: newest request wins, failures keep the
 * last good settings, and readiness reflects only the selected reviewer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalReviewSettingsSnapshot } from "workbench-shared/workbench/approval-review/approval-review-settings";
import ApprovalReviewSettingsController, { selectedReviewerReady } from "./ApprovalReviewSettingsController";

function settings(selected: ApprovalReviewSettingsSnapshot["selected"], typesafeReady: boolean): ApprovalReviewSettingsSnapshot {
  return {
    selected,
    reviewers: [
      { id: "typesafe-jev", ready: typesafeReady, detail: "", secret: typesafeReady ? "key" : null },
      { id: "zen-jev", ready: false, detail: "" },
      { id: "codex-auto-review", ready: true, detail: "" },
    ],
  };
}

test("readiness follows the selected reviewer only", () => {
  assert.equal(selectedReviewerReady(null), null);
  assert.equal(selectedReviewerReady(settings(null, true)), false);
  assert.equal(selectedReviewerReady(settings("typesafe-jev", false)), false);
  assert.equal(selectedReviewerReady(settings("codex-auto-review", false)), true);
});

test("a stale read never overwrites a newer save, and a failed save keeps the last good settings", async () => {
  let releaseRead!: (value: ApprovalReviewSettingsSnapshot) => void;
  let failUpdate = false;
  const controller = new ApprovalReviewSettingsController({
    read: () => new Promise(resolve => { releaseRead = resolve; }),
    update: async update => {
      if (failUpdate) throw new Error("daemon offline");
      return settings("typesafe-jev", update.secrets?.["typesafe-jev"] !== null);
    },
  });
  const reading = controller.refresh();
  await controller.saveSecret("typesafe-jev", "key");
  releaseRead(settings(null, false));
  await reading;
  assert.equal(controller.getSnapshot().settings?.selected, "typesafe-jev");

  failUpdate = true;
  await controller.select("zen-jev");
  assert.equal(controller.getSnapshot().settings?.selected, "typesafe-jev");
  assert.match(controller.getSnapshot().error, /daemon offline/u);
  assert.equal(controller.getSnapshot().busy, false);
});
