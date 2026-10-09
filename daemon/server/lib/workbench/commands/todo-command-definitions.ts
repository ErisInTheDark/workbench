/*
 * Exports:
 * - WorkbenchTodoRequestSchema: validate one managed caller's todo list, add, or remove request.
 * - WORKBENCH_TODO_COMMANDS: `wb todo` (list or add) and `wb todo remove`, shared by CLI and MCP.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { WorkbenchThreadTodoTextSchema } from "workbench-shared/workbench/thread/thread-todo";
import { WorkbenchAgentCommandFlags, WorkbenchCommandArgumentError, preservePowerShellTrailingPaths } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const todoId = z.number().int().nonnegative();

const caller = { cwd: z.string().trim().min(1), harness: ProviderKeySchema, threadId: z.string().trim().min(1) };
export const WorkbenchTodoRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), ...caller }).strict(),
  z.object({ action: z.literal("add"), text: WorkbenchThreadTodoTextSchema, required: z.boolean(), ...caller }).strict(),
  z.object({ action: z.literal("remove"), ids: z.array(todoId).min(1), ...caller }).strict(),
]);

const todoInput = z.object({
  text: WorkbenchThreadTodoTextSchema.optional().describe("Todo text. Omit to list this thread's todos instead."),
  required: z.boolean().optional().describe("Mark the todo required; defaults to optional."),
}).strict();

const todo = defineWorkbenchAgentCommand({
  words: ["todo"],
  usage: "wb todo [--required|--optional] [-- <text>]",
  description: "Record follow-up work for after the current task. Without text, lists this thread's todos.",
  effects: { readOnly: false },
  helpGroups: ["todo"],
  mcpCodeModeEligible: true,
  inputSchema: todoInput,
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { boolean: ["--required", "--optional"], values: [] }), {
      boolean: ["--required", "--optional"], trailing: true,
    });
    if (flags.has("--required") && flags.has("--optional")) {
      throw new WorkbenchCommandArgumentError("unexpectedArgument", "--optional", "Choose --required or --optional, not both.");
    }
    const text = flags.trailing.join(" ").trim();
    if (!text && (flags.has("--required") || flags.has("--optional"))) {
      throw new WorkbenchCommandArgumentError("missingArgument", "--", "Todo text is required with --required or --optional.");
    }
    return text ? { text, required: flags.has("--required") } : {};
  },
  buildRequest(input, context) {
    const body = managedWorkbenchAgentCommandBody(context);
    return postWorkbenchAgentCommand("/internal/todo", input.text === undefined
      ? { action: "list", ...body }
      : { action: "add", text: input.text, required: input.required ?? false, ...body });
  },
});

const todoRemove = defineWorkbenchAgentCommand({
  words: ["todo", "remove"],
  usage: "wb todo remove -- <id>...",
  description: "Remove this thread's todos by id.",
  effects: { destructive: true, readOnly: false },
  helpGroups: ["todo"],
  mcpCodeModeEligible: true,
  inputSchema: z.object({ ids: z.array(todoId).min(1) }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: [] }), { trailing: true });
    const ids = flags.trailing.map((value) => value.replace(/^#/u, ""));
    if (!ids.length) throw new WorkbenchCommandArgumentError("missingArgument", "--", "At least one todo id is required.");
    if (ids.some((value) => !/^\d+$/u.test(value))) {
      throw new WorkbenchCommandArgumentError("argumentMustBeInteger", "--", "Todo ids must be non-negative integers.");
    }
    return { ids: ids.map(Number) };
  },
  buildRequest({ ids }, context) {
    return postWorkbenchAgentCommand("/internal/todo", { action: "remove", ids, ...managedWorkbenchAgentCommandBody(context) });
  },
});

export const WORKBENCH_TODO_COMMANDS = [todo, todoRemove] as const;
