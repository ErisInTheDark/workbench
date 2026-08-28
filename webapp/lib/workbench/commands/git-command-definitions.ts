/*
 * Exports:
 * - WORKBENCH_GIT_COMMANDS: typed commit-selection and commit definitions shared by CLI and MCP. Keywords: workbench, git, commands, commit.
 */
import { z } from "zod";

import { preservePowerShellTrailingPaths, WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
const pathsSchema = z.array(requiredText).min(1);

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

function selectionCommand(action: "add" | "unstage") {
  return defineWorkbenchAgentCommand({
    description: action === "add"
      ? "Add currently changed files beneath the paths to this thread's commit selection."
      : "Remove exact files or descendants from this thread's commit selection.",
    helpGroups: ["git"],
    words: ["git", action],
    usage: `wb git ${action} [--worktree <absolute-path>] -- <path> [<path>...]`,
    inputSchema: z.object({ paths: pathsSchema, targetWorktree: requiredText.optional() }).strict(),
    parseCliArgs(args) {
      const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args), { trailing: true, values: ["--worktree"] });
      return { paths: flags.trailing, targetWorktree: flags.optional("--worktree") ?? undefined };
    },
    buildRequest(input, { callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git", {
        action, cwd, paths: input.paths,
        ...(input.targetWorktree ? { targetWorktree: input.targetWorktree } : {}),
        threadId: requireCallerThreadId(callerThreadId),
      });
    },
  });
}

const commit = defineWorkbenchAgentCommand({
  description: "Commit selected files with a title and optional description, or amend them into one linear unpushed ancestor, then clear the selection on success.",
  helpGroups: ["git"],
  words: ["git", "commit"],
  usage: "wb git commit [--worktree <absolute-path>] [--amend <commit-sha>] --title <title> [--description <description>]",
  inputSchema: z.object({
    amendTarget: requiredText.optional(),
    description: z.string().default(""),
    targetWorktree: requiredText.optional(),
    title: requiredText,
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      leadingDashValues: ["--description", "--title"],
      values: ["--amend", "--description", "--title", "--worktree"],
    });
    return {
      amendTarget: flags.optional("--amend") ?? undefined,
      description: flags.optional("--description") ?? "",
      targetWorktree: flags.optional("--worktree") ?? undefined,
      title: flags.required("--title"),
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    const description = input.description.trim();
    return postWorkbenchAgentCommand("/api/git", {
      action: "commit",
      ...(input.amendTarget ? { amendTarget: input.amendTarget } : {}),
      cwd,
      message: description ? `${input.title}\n\n${description}` : input.title,
      ...(input.targetWorktree ? { targetWorktree: input.targetWorktree } : {}),
      threadId: requireCallerThreadId(callerThreadId),
    });
  },
});

export const WORKBENCH_GIT_COMMANDS = [selectionCommand("add"), selectionCommand("unstage"), commit] as const;
