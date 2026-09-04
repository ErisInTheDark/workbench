/*
 * Exports:
 * - WorkbenchRequestUserInputSchema: validate public wb questionnaire arguments. Keywords: questionnaire, command, schema, freeform.
 * - WorkbenchRequestUserInputCommandSchema/WorkbenchRequestUserInputCommandInput: validate one trusted questionnaire command request with stable replay identity. Keywords: questionnaire, caller, cwd, reload.
 * - WORKBENCH_QUESTIONNAIRE_COMMANDS: expose the steer-safe, reload-preserved request_user_input Code Mode long wait. Keywords: questionnaire, MCP, wait, Code Mode.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  postWorkbenchAgentCommand,
} from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
const optionSchema = z.object({
  description: z.string(),
  label: requiredText,
}).strict();
const questionSchema = z.object({
  header: requiredText.max(12),
  id: requiredText,
  options: z.array(optionSchema).max(3),
  question: requiredText,
}).strict();

export const WorkbenchRequestUserInputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(3),
}).strict();

export const WorkbenchRequestUserInputCommandSchema = WorkbenchRequestUserInputSchema.extend({
  callerThreadId: requiredText,
  cwd: requiredText,
  requestKey: requiredText
    .refine((value) => value.startsWith(WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX))
    .optional(),
}).strict();

export type WorkbenchRequestUserInputCommandInput = z.infer<typeof WorkbenchRequestUserInputCommandSchema>;

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

const requestUserInput = defineWorkbenchAgentCommand({
  description: "Ask one to three questions and wait for the user response; empty options request freeform text.",
  helpGroups: ["questionnaire"],
  inputSchema: WorkbenchRequestUserInputSchema,
  mcpCodeModeEligible: true,
  mcpRuntimeDrainPolicy: "preserve-across-reload",
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--questions-json"] });
    const source = flags.required("--questions-json");
    let questions: z.input<typeof questionSchema>[];
    try {
      questions = WorkbenchRequestUserInputSchema.shape.questions.parse(JSON.parse(source));
    } catch {
      throw new Error("wb request user input requires --questions-json to contain a JSON array.");
    }
    return { questions };
  },
  usage: "wb request user input --questions-json <json-array>",
  words: ["request", "user", "input"],
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/request-user-input", {
      callerThreadId: requireCallerThreadId(callerThreadId),
      cwd,
      questions: input.questions,
      requestKey: `${WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX}${randomUUID()}`,
    }, "json");
  },
});

export const WORKBENCH_QUESTIONNAIRE_COMMANDS = [requestUserInput] as const;
