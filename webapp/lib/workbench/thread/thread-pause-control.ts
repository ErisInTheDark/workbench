/*
 * Exports:
 * - WORKBENCH_PAUSE_CONTROL_KIND/WORKBENCH_PAUSE_CONTROL_MARKER/WORKBENCH_PAUSE_PENDING_HALO_MS: shared pause-control constants. Keywords: pause, questionnaire, control.
 * - createWorkbenchPauseControlInput: build the hidden control steer that asks an agent to enter a pause questionnaire. Keywords: pause, steer, user input.
 * - isWorkbenchPauseControlRequest: detect the special hidden pause questionnaire across harnesses. Keywords: pause, questionnaire, sentinel.
 * - createWorkbenchPauseResumeResponse: build the response that resumes a paused agent. Keywords: pause, resume, questionnaire.
 */

import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import type { WorkbenchUserInputControlKind, WorkbenchUserInputRequest, WorkbenchUserInputResponse } from "../../types";
import { createTextInput } from "../../codex/protocol";

export const WORKBENCH_PAUSE_CONTROL_KIND = "pause" satisfies WorkbenchUserInputControlKind;
export const WORKBENCH_PAUSE_CONTROL_MARKER = "<!-- workbench-pause-control -->";
export const WORKBENCH_COLLABORATION_CONTROL_MARKER = "<!-- workbench-collaboration-control -->";
export const WORKBENCH_PAUSE_PENDING_HALO_MS = 5000;
export const WORKBENCH_PAUSE_RESUME_QUESTION_ID = "resume";
export const WORKBENCH_PAUSE_RESUME_LABEL = "Resume";

export function createWorkbenchPauseControlInput(): UserInput[] {
  return [createTextInput(`${WORKBENCH_COLLABORATION_CONTROL_MARKER}
Workbench pause requested.

Immediately call your structured user-input/questionnaire tool and wait. The request must include this marker in the title or summary:
${WORKBENCH_PAUSE_CONTROL_MARKER}

Use exactly one question:
- id: ${WORKBENCH_PAUSE_RESUME_QUESTION_ID}
- header: Paused
- question: Workbench paused this agent. Resume when the user clicks Resume.
- option label: ${WORKBENCH_PAUSE_RESUME_LABEL}

Do not do other work before entering the questionnaire wait. After the tool returns, continue using any user steers received while paused.`)];
}

function requestTextParts(request: WorkbenchUserInputRequest) {
  return [
    request.id,
    request.title,
    request.summary,
    request.submitLabel,
    ...request.questions.flatMap((question) => [
      question.id,
      question.header,
      question.question,
      ...question.options.flatMap((option) => [option.label, option.description]),
    ]),
  ];
}

export function isWorkbenchPauseControlRequest(request: WorkbenchUserInputRequest) {
  return requestTextParts(request).some((value) => value.includes(WORKBENCH_PAUSE_CONTROL_MARKER));
}

export function createWorkbenchPauseResumeResponse(): WorkbenchUserInputResponse {
  return {
    answers: {
      [WORKBENCH_PAUSE_RESUME_QUESTION_ID]: {
        answers: [WORKBENCH_PAUSE_RESUME_LABEL],
      },
    },
  };
}
