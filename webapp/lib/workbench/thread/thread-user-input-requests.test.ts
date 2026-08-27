/*
 * No production exports. Tests protect accepted and declined approval-note wrapping without changing ordinary questionnaire text. Keywords: approval, questionnaire, steer, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../types.ts";
import {
  getWorkbenchApprovalSupplementalSteerText,
  WORKBENCH_APPROVAL_NOTE_TAG_WRAPPER,
} from "./thread-user-input-requests.ts";

const approvalRequest: WorkbenchUserInputRequest = {
  id: "approval-1",
  questions: [{
    allowOther: true,
    header: "Approval",
    id: "decision",
    isSecret: false,
    options: [
      { description: "Run this command once.", label: "Allow once" },
      { description: "Allow matching commands.", label: "Allow for session" },
      { description: "Do not run this command.", label: "Decline" },
    ],
    question: "Run outside the sandbox?",
  }],
  submitLabel: "Submit",
  summary: "Command approval",
  title: "Approval needed",
};

function response(answers: string[]): WorkbenchUserInputResponse {
  return { answers: { decision: { answers } } };
}

test("custom approval notes carry the authoritative approval outcome", () => {
  const accepted = getWorkbenchApprovalSupplementalSteerText(
    approvalRequest,
    response(["Allow for session", "This command is expected."]),
  );
  const declined = getWorkbenchApprovalSupplementalSteerText(
    approvalRequest,
    response(["Decline", "The cwd is wrong."]),
  );

  assert.deepEqual(WORKBENCH_APPROVAL_NOTE_TAG_WRAPPER.read(accepted ?? ""), {
    attributes: { type: "accepted" },
    body: "This command is expected.",
  });
  assert.deepEqual(WORKBENCH_APPROVAL_NOTE_TAG_WRAPPER.read(declined ?? ""), {
    attributes: { type: "declined" },
    body: "The cwd is wrong.",
  });
});

test("approval responses without custom text do not create a supplemental steer", () => {
  assert.equal(
    getWorkbenchApprovalSupplementalSteerText(approvalRequest, response(["Allow once"])),
    null,
  );
});
