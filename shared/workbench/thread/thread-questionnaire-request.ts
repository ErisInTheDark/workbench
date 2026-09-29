/*
 * Exports:
 * - WorkbenchQuestionnaireInputQuestion: loose questionnaire question accepted from model or wire input. Keywords: questionnaire, input, repair.
 * - repairQuestionnaireQuestion: fill missing question identity and clean options into the durable question shape. Keywords: questionnaire, repair, id, header.
 * - buildWorkbenchQuestionnaireRequest: assemble a durable questionnaire request from loose input under shared presentation policy. Keywords: questionnaire, request, policy.
 * - buildWorkbenchApprovalRequest: assemble the fixed approval decision request from shared approval vocabulary. Keywords: questionnaire, approval, request.
 */

import type {
  WorkbenchUserInputApprovalContext,
  WorkbenchUserInputOption,
  WorkbenchUserInputQuestion,
  WorkbenchUserInputRequest,
} from "../../types.ts";
import { getQuestionnaireTitle } from "./thread-questionnaire-transcript.ts";
import {
  WORKBENCH_APPROVAL_ALLOW_ONCE_LABEL,
  WORKBENCH_APPROVAL_ALLOW_SESSION_LABEL,
  WORKBENCH_APPROVAL_DECISION_QUESTION_ID,
  WORKBENCH_APPROVAL_DECLINE_LABEL,
} from "./thread-user-input-requests.ts";

const QUESTIONNAIRE_SUBMIT_LABEL = "Submit";
const QUESTIONNAIRE_MULTI_QUESTION_SUMMARY = "The agent is paused until you provide a response.";
const QUESTIONNAIRE_FALLBACK_TITLE = "Questionnaire";

export type WorkbenchQuestionnaireInputQuestion = {
  allowOther?: boolean;
  header?: string | null;
  id?: string | null;
  isSecret?: boolean;
  options: readonly WorkbenchUserInputOption[] | null;
  question?: string | null;
};

function normalizeQuestionId(value: string | null | undefined, index: number) {
  const sanitized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || `question-${index + 1}`;
}

function repairQuestionOptions(options: readonly WorkbenchUserInputOption[] | null): WorkbenchUserInputOption[] {
  return (options ?? []).flatMap((option) => {
    const label = option.label.trim();
    return label ? [{ description: option.description.trim(), label }] : [];
  });
}

function createFallbackQuestion(): WorkbenchUserInputQuestion {
  return {
    allowOther: true,
    header: "Question 1",
    id: "question-1",
    isSecret: false,
    options: [],
    question: "How should the agent continue?",
  };
}

export function repairQuestionnaireQuestion(
  index: number,
  input: WorkbenchQuestionnaireInputQuestion,
): WorkbenchUserInputQuestion | null {
  const options = repairQuestionOptions(input.options);
  const header = input.header?.trim() ?? "";
  const questionText = input.question?.trim() ?? "";
  if (!header && !questionText && !options.length) return null;
  return {
    allowOther: input.allowOther ?? true,
    header,
    id: normalizeQuestionId(input.id, index),
    isSecret: input.isSecret ?? false,
    options,
    question: questionText || header || `Question ${index + 1}`,
  };
}

export function buildWorkbenchQuestionnaireRequest(input: {
  id: string;
  questions: readonly WorkbenchQuestionnaireInputQuestion[];
}): WorkbenchUserInputRequest {
  const questions = input.questions
    .map((question, index) => repairQuestionnaireQuestion(index, question))
    .filter((question): question is WorkbenchUserInputQuestion => question !== null);
  const repaired = questions.length ? questions : [createFallbackQuestion()];
  return {
    id: input.id,
    questions: repaired,
    submitLabel: QUESTIONNAIRE_SUBMIT_LABEL,
    summary: repaired.length > 1 ? QUESTIONNAIRE_MULTI_QUESTION_SUMMARY : "",
    title: getQuestionnaireTitle({ title: QUESTIONNAIRE_FALLBACK_TITLE, questions: repaired }),
  };
}

export function buildWorkbenchApprovalRequest(input: {
  actionLabel: string;
  approval?: WorkbenchUserInputApprovalContext;
  details: Array<string | null>;
  id: string;
  prompt: string;
  title: string;
}): WorkbenchUserInputRequest {
  return {
    id: input.id,
    approval: input.approval,
    questions: [{
      allowOther: false,
      header: "Approval",
      id: WORKBENCH_APPROVAL_DECISION_QUESTION_ID,
      isSecret: false,
      options: [
        {
          description: `Approve this ${input.actionLabel} just for the current action.`,
          label: WORKBENCH_APPROVAL_ALLOW_ONCE_LABEL,
        },
        {
          description: `Approve this ${input.actionLabel} for the rest of the session.`,
          label: WORKBENCH_APPROVAL_ALLOW_SESSION_LABEL,
        },
        {
          description: `Do not approve this ${input.actionLabel}.`,
          label: WORKBENCH_APPROVAL_DECLINE_LABEL,
        },
      ],
      question: [input.prompt, ...input.details.filter((value): value is string => Boolean(value?.trim()))].join("\n\n"),
    }],
    submitLabel: QUESTIONNAIRE_SUBMIT_LABEL,
    summary: "",
    title: input.title,
  };
}
