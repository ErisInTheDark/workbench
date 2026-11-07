/*
 * Exports:
 * - WORKBENCH_SUBAGENT_COMMANDS: typed subagent lifecycle, wait, and queue command definitions shared by CLI and MCP.
 */
import { z } from "zod";

import {
  WorkbenchSubagentDequeueInputSchema,
  WorkbenchSubagentQueueInputSchema,
} from "../subagent/subagent-queue-contract";
import { WORKBENCH_TOOL_REFERENCE_INPUT_DESCRIPTION } from "../instructions/tool-reference-markup";
import { WorkbenchAgentCommandFlags, WorkbenchCommandArgumentError } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
const targetFields = {
  names: z.array(requiredText).optional(),
  threadIds: z.array(requiredText).optional(),
};
function refineTargets({ names = [], threadIds = [] }: { names?: string[]; threadIds?: string[] }, context: z.RefinementCtx) {
  if (!names.length && !threadIds.length) context.addIssue({ code: "custom", message: "At least one name or thread ID target is required." });
  if (new Set(threadIds).size !== threadIds.length) context.addIssue({ code: "custom", message: "Thread ID targets must be unique." });
  if (new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
    context.addIssue({ code: "custom", message: "Name targets must be unique ignoring case." });
  }
}
const targetsSchema = z.object(targetFields).strict().superRefine(refineTargets);

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

function parseTargets(args: string[]) {
  const flags = new WorkbenchAgentCommandFlags(args, { repeatable: ["--id", "--name"] });
  return { names: flags.repeated("--name"), threadIds: flags.repeated("--id") };
}

function targetsBody(input: { names?: string[]; threadIds?: string[] }) {
  return {
    ...(input.names?.length ? { names: input.names } : {}),
    ...(input.threadIds?.length ? { threadIds: input.threadIds } : {}),
  };
}

const list = defineWorkbenchAgentCommand({
  description: "List unsettled direct children, or settled history.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["subagent"],
  words: ["subagent", "list"],
  usage: "wb subagent list [--settled [--cursor <cursor>] [--limit <1-20>]]",
  inputSchema: z.object({
    cursor: requiredText.optional(),
    limit: z.number().int().min(1).max(20).optional(),
    settled: z.boolean().default(false),
  }).strict().superRefine(({ cursor, limit, settled }, context) => {
    if (!settled && (cursor || limit !== undefined)) context.addIssue({ code: "custom", message: "cursor and limit require settled history." });
  }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--settled"], values: ["--cursor", "--limit"] });
    const limit = flags.optionalNonNegativeInteger("--limit");
    return {
      cursor: flags.optional("--cursor") ?? undefined,
      limit: limit ?? undefined,
      settled: flags.has("--settled"),
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "list",
      callerThreadId: requireCallerThreadId(callerThreadId),
      cwd,
      settled: input.settled,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }, "subagent-list");
  },
});

const folder = requiredText.describe("`<host>[:<folder>]`: another folder of this or another project, on this or another daemon; other projects need `<folder>`. Needs the user's approval.");

const profiles = defineWorkbenchAgentCommand({
  description: "List the subagent profiles available to this thread, or to another folder's daemon with folder.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["subagent"],
  words: ["subagent", "profiles"],
  usage: "wb subagent profiles [--folder <host>[:<folder>]]",
  inputSchema: z.object({ folder: folder.optional() }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--folder"] });
    return { folder: flags.optional("--folder") ?? undefined };
  },
  buildRequest(input, { callerThreadId, cwd, workbenchOrigin }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "profiles", callerThreadId: requireCallerThreadId(callerThreadId), cwd,
      ...(input.folder ? { folder: input.folder } : {}),
      ...(workbenchOrigin ? { workbenchOrigin } : {}),
    }, "json");
  },
});

const create = defineWorkbenchAgentCommand({
  description: "Create and start a direct child, then print its thread ID. folder places it in another folder or project; use that folder's profiles.",
  helpGroups: ["subagent"],
  mcpWorkdir: true,
  words: ["subagent", "create"],
  usage: "wb subagent create --profile <profile-id> --name <name> --title <title> --message <message> --user-visible-simple-version <text> [--folder <host>[:<folder>]]",
  inputSchema: z.object({
    folder: folder.optional(),
    message: requiredText.describe(WORKBENCH_TOOL_REFERENCE_INPUT_DESCRIPTION),
    name: requiredText,
    profileId: requiredText,
    title: requiredText,
    userVisibleSimpleVersion: requiredText.describe("One or two plain sentences summarising the task for the user, without technical detail."),
  }).strict(),
  toolReferenceInput: ["message"],
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      values: ["--profile", "--name", "--title", "--message", "--user-visible-simple-version", "--folder"],
    });
    return {
      folder: flags.optional("--folder") ?? undefined,
      message: flags.required("--message"),
      name: flags.required("--name"),
      profileId: flags.required("--profile"),
      title: flags.required("--title"),
      userVisibleSimpleVersion: flags.required("--user-visible-simple-version"),
    };
  },
  buildRequest(input, { callerThreadId, cwd, workbenchOrigin }) {
    const { folder: target, ...rest } = input;
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "create", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...rest,
      ...(target ? { folder: target } : {}),
      ...(workbenchOrigin ? { workbenchOrigin } : {}),
    }, "subagent-create");
  },
});

const wait = defineWorkbenchAgentCommand({
  description: "Wait until any selected child needs attention or reaches a terminal state.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["subagent"],
  mcpCodeModeEligible: true,
  mcpRuntimeDrainPolicy: "preserve-across-reload",
  mcpSteerInterruptible: true,
  words: ["subagent", "wait"],
  usage: "wb subagent wait (--id <id> | --name <name>) [...]",
  inputSchema: targetsSchema,
  parseCliArgs: parseTargets,
  buildRequest(input, { callerThreadId, cwd, workbenchOrigin }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "wait", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...targetsBody(input),
      ...(workbenchOrigin ? { workbenchOrigin } : {}),
    });
  },
});

const stop = defineWorkbenchAgentCommand({
  description: "Stop one or more direct child threads.",
  effects: { destructive: true },
  helpGroups: ["subagent"],
  words: ["subagent", "stop"],
  usage: "wb subagent stop (--id <id> | --name <name>) [...] [--settle]",
  inputSchema: z.object({
    ...targetFields,
    settle: z.boolean().default(false).describe("Then settle each stopped child, reporting each outcome."),
  }).strict().superRefine(refineTargets),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--settle"], repeatable: ["--id", "--name"] });
    return { names: flags.repeated("--name"), threadIds: flags.repeated("--id"), settle: flags.has("--settle") };
  },
  buildRequest(input, { callerThreadId, cwd, workbenchOrigin }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "stop", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...targetsBody(input),
      ...(input.settle ? { settle: true } : {}),
      ...(workbenchOrigin ? { workbenchOrigin } : {}),
    }, input.settle ? "subagent-settle" : "native");
  },
});

const settle = defineWorkbenchAgentCommand({
  description: "Settle one or more completed or stopped direct children, reporting each outcome. handover first moves each child's Git claims, saved stash and todos to you.",
  helpGroups: ["subagent"],
  words: ["subagent", "settle"],
  usage: "wb subagent settle (--id <id> | --name <name>) [...] [--handover]",
  inputSchema: z.object({
    ...targetFields,
    handover: z.boolean().default(false).describe("Adopt each child's Git claims and saved stash and move its todos to you before settling."),
  }).strict().superRefine(refineTargets),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--handover"], repeatable: ["--id", "--name"] });
    return { names: flags.repeated("--name"), threadIds: flags.repeated("--id"), handover: flags.has("--handover") };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "settle", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...targetsBody(input),
      ...(input.handover ? { handover: true, callerHarness } : {}),
    }, "subagent-settle");
  },
});

const promote = defineWorkbenchAgentCommand({
  description: "Turn direct children into user-owned sidebar threads in their own projects, one way; you stop managing them and their names free up; does not start turns or propose changes.",
  helpGroups: ["subagent"],
  words: ["subagent", "promote"],
  usage: "wb subagent promote (--id <id> | --name <name>) [...]",
  inputSchema: targetsSchema,
  parseCliArgs: parseTargets,
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "promote", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...targetsBody(input),
    });
  },
});

const approval = defineWorkbenchAgentCommand({
  description: "Answer one direct child's pending outside-sandbox request: forward it to the user on this thread and wait for their decision, or deny it.",
  helpGroups: ["subagent"],
  words: ["subagent", "approval"],
  usage: "wb subagent approval (--id <id> | --name <name>) (--forward [--justification <text>] | --deny [--feedback <text>])",
  inputSchema: z.object({
    name: requiredText.optional(),
    threadId: requiredText.optional(),
    decision: z.enum(["forward", "deny"]),
    justification: requiredText.optional().describe("Forward only: replaces the child's justification; otherwise the user sees `<name>: <its justification>`."),
    feedback: requiredText.optional().describe("Deny only: told to the child."),
  }).strict().superRefine((input, context) => {
    if (Boolean(input.name) === Boolean(input.threadId)) context.addIssue({ code: "custom", message: "Name exactly one subagent by name or thread ID." });
    if (input.justification && input.decision !== "forward") context.addIssue({ code: "custom", message: "justification needs forward." });
    if (input.feedback && input.decision !== "deny") context.addIssue({ code: "custom", message: "feedback needs deny." });
  }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      boolean: ["--forward", "--deny"], values: ["--id", "--name", "--justification", "--feedback"],
    });
    if (flags.has("--forward") === flags.has("--deny")) {
      throw new WorkbenchCommandArgumentError("missingArgument", "--forward | --deny", "Choose exactly one of --forward or --deny.");
    }
    return {
      name: flags.optional("--name") ?? undefined,
      threadId: flags.optional("--id") ?? undefined,
      decision: flags.has("--forward") ? "forward" as const : "deny" as const,
      justification: flags.optional("--justification") ?? undefined,
      feedback: flags.optional("--feedback") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagents", {
      action: "approval", callerThreadId: requireCallerThreadId(callerThreadId), cwd,
      ...targetsBody({ names: input.name ? [input.name] : [], threadIds: input.threadId ? [input.threadId] : [] }),
      decision: input.decision,
      ...(input.justification ? { justification: input.justification } : {}),
      ...(input.feedback ? { feedback: input.feedback } : {}),
    });
  },
});

/** Split the leading `<queue>` operand from the flag grammar. */
function splitQueueOperand(args: string[]) {
  const [queue, ...rest] = args;
  if (!queue || queue.startsWith("-")) throw new WorkbenchCommandArgumentError("missingArgument", "<queue>", "A queue name operand is required first.");
  return { queue, rest };
}

const queue = defineWorkbenchAgentCommand({
  description: "Parent-declared turn queue for contended work. With description: join (or resume/move when queued) and long-wait until you hold it; hold lasts until subagent_dequeue. Without: show queue info (a parent call declares the queue). after/before place relative to a member or \"parent\"; parent-only name moves that member. Workbench Long Wait; steers interrupt it but keep your place.",
  helpGroups: ["subagent"],
  mcpCodeModeEligible: true,
  mcpRuntimeDrainPolicy: "preserve-across-reload",
  mcpSteerInterruptible: true,
  words: ["subagent", "queue"],
  usage: "wb subagent queue <queue> [--description <work>] [--after <member> | --before <member>] [--name <member>]",
  inputSchema: WorkbenchSubagentQueueInputSchema,
  parseCliArgs(args) {
    const { queue, rest } = splitQueueOperand(args);
    const flags = new WorkbenchAgentCommandFlags(rest, { values: ["--description", "--after", "--before", "--name"] });
    return {
      queue,
      after: flags.optional("--after") ?? undefined,
      before: flags.optional("--before") ?? undefined,
      description: flags.optional("--description") ?? undefined,
      name: flags.optional("--name") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagent-queue", {
      action: "queue", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...input,
    });
  },
});

const dequeue = defineWorkbenchAgentCommand({
  description: "Leave a subagent queue, handing your hold to the next member. Parent-only name removes that member instead.",
  helpGroups: ["subagent"],
  words: ["subagent", "dequeue"],
  usage: "wb subagent dequeue <queue> [--name <member>]",
  inputSchema: WorkbenchSubagentDequeueInputSchema,
  parseCliArgs(args) {
    const { queue, rest } = splitQueueOperand(args);
    const flags = new WorkbenchAgentCommandFlags(rest, { values: ["--name"] });
    return { queue, name: flags.optional("--name") ?? undefined };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/subagent-queue", {
      action: "dequeue", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...input,
    });
  },
});

export const WORKBENCH_SUBAGENT_COMMANDS = [list, profiles, create, wait, stop, settle, promote, approval, queue, dequeue] as const;
