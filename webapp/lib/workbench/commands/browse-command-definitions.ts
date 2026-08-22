/*
 * Exports:
 * - WORKBENCH_BROWSE_COMMANDS: typed BrowseMD and session command definitions shared by CLI and MCP. Keywords: workbench, browse, commands, sessions.
 */
import { z } from "zod";

import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  getWorkbenchAgentCommand,
  postWorkbenchAgentCommand,
  queryWorkbenchAgentCommandPath,
} from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);

function resolveThreadId(explicitThreadId: string | undefined, callerThreadId: string | null) {
  const threadId = explicitThreadId ?? callerThreadId;
  if (!threadId) throw new Error("A managed Workbench thread identity is required.");
  return threadId;
}

function parseVariables(values: string[]) {
  const variables: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const key = separator > 0 ? value.slice(0, separator).trim() : "";
    if (!key) throw new Error(`Browse variable must use key=value syntax: ${value}`);
    variables[key] = value.slice(separator + 1);
  }
  return variables;
}

const run = defineWorkbenchAgentCommand({
  description: "Run inline BrowseMD commands or one project BrowseMD script.",
  effects: { openWorld: true },
  helpGroups: ["browse"],
  words: ["browse", "run"],
  usage: "wb browse run --thread <id> [--session <name>] (--command <line>... | --script-path <file>) [--var <key=value>...] [--summary <text>]",
  inputSchema: z.object({
    commands: z.array(requiredText).optional(),
    scriptPath: requiredText.optional(),
    session: requiredText.optional(),
    summary: requiredText.optional(),
    threadId: requiredText.optional(),
    variables: z.record(z.string(), z.string()).optional(),
  }).strict().superRefine(({ commands = [], scriptPath }, context) => {
    if ((!commands.length && !scriptPath) || (commands.length && scriptPath)) {
      context.addIssue({ code: "custom", message: "Provide either commands or scriptPath, but not both." });
    }
  }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      repeatable: ["--command", "--var"],
      values: ["--thread", "--session", "--script-path", "--summary"],
    });
    return {
      commands: flags.repeated("--command"),
      scriptPath: flags.optional("--script-path") ?? undefined,
      session: flags.optional("--session") ?? undefined,
      summary: flags.optional("--summary") ?? undefined,
      threadId: flags.required("--thread"),
      variables: parseVariables(flags.repeated("--var")),
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/browse", {
      cwd,
      ...(input.commands?.length ? { script: input.commands.join("\n") } : { scriptPath: input.scriptPath as string }),
      ...(input.session ? { session: input.session } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.variables && Object.keys(input.variables).length ? { vars: input.variables } : {}),
      threadId: resolveThreadId(input.threadId, callerThreadId),
    }, "browse-command");
  },
});

const raw = defineWorkbenchAgentCommand({
  description: "Run the explicitly gated raw Browse CLI passthrough.",
  effects: { openWorld: true },
  hideFromMcp: true,
  helpGroups: ["browse"],
  words: ["browse", "raw"],
  usage: "wb browse raw --thread <id> -- <Browse CLI args>",
  inputSchema: z.object({ args: z.array(z.string()).min(1), threadId: requiredText.optional() }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { trailing: true, values: ["--thread"] });
    return { args: flags.trailing, threadId: flags.required("--thread") };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/browse", { args: input.args, cwd, threadId: resolveThreadId(input.threadId, callerThreadId) }, "browse-command");
  },
});

const sessions = defineWorkbenchAgentCommand({
  description: "List Workbench-known browser sessions for the thread.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["browse"],
  words: ["browse", "sessions"],
  usage: "wb browse sessions --thread <id>",
  inputSchema: z.object({ threadId: requiredText.optional() }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--thread"] });
    return { threadId: flags.required("--thread") };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    return getWorkbenchAgentCommand(queryWorkbenchAgentCommandPath("/api/browse/sessions", {
      cwd, threadId: resolveThreadId(input.threadId, callerThreadId),
    }), "json");
  },
});

function sessionCommand(action: "forget" | "stop") {
  return defineWorkbenchAgentCommand({
    description: action === "stop"
      ? "Stop a browser session without deleting persistent profile data."
      : "Forget a stopped session and delete its persistent profile data.",
    effects: action === "forget" ? { destructive: true } : {},
    helpGroups: ["browse"],
    words: ["browse", action],
    usage: `wb browse ${action} --thread <id> --session <name>${action === "stop" ? " [--force]" : ""}`,
    inputSchema: z.object({ force: z.boolean().default(false), session: requiredText, threadId: requiredText.optional() }).strict(),
    parseCliArgs(args) {
      const flags = new WorkbenchAgentCommandFlags(args, { boolean: action === "stop" ? ["--force"] : [], values: ["--thread", "--session"] });
      return { force: flags.has("--force"), session: flags.required("--session"), threadId: flags.required("--thread") };
    },
    buildRequest(input, { callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/browse/sessions", {
        action, cwd,
        ...(action === "stop" && input.force ? { force: true } : {}),
        session: input.session,
        threadId: resolveThreadId(input.threadId, callerThreadId),
      }, "browse-session-control");
    },
  });
}

export const WORKBENCH_BROWSE_COMMANDS = [run, raw, sessions, sessionCommand("stop"), sessionCommand("forget")] as const;
