/*
 * Exports:
 * - WORKBENCH_GIT_COMMANDS: typed commit-selection and commit definitions shared by CLI and MCP, plus CLI-only history amend.
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

const amend = defineWorkbenchAgentCommand({
  description: "Rewrite unpushed linear commits: fold selected files or a new message into one commit, or change author, committer, dates and co-authors across many.",
  helpGroups: ["git"],
  hideFromMcp: true,
  words: ["git", "amend"],
  usage: "wb git amend [--commit <commit>]... [--range <base>..<tip>]... [--worktree <absolute-path>] [--selected] [--title <title> [--description <description>]] [--author \"Name <email>\"] [--author-date <date>] [--committer \"Name <email>\"] [--committer-date <date>] [--co-author \"Name <email>\"]... [--no-co-authors]",
  inputSchema: z.object({
    author: requiredText.optional(),
    authorDate: requiredText.optional(),
    clearCoAuthors: z.boolean().default(false),
    coAuthors: z.array(requiredText).default([]),
    commits: z.array(requiredText).default([]),
    committer: requiredText.optional(),
    committerDate: requiredText.optional(),
    description: z.string().default(""),
    includeSelection: z.boolean().default(false),
    ranges: z.array(requiredText).default([]),
    targetWorktree: requiredText.optional(),
    title: requiredText.optional(),
  }).strict().refine((input) => input.title || !input.description.trim(), {
    message: "--description requires --title.",
  }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      boolean: ["--no-co-authors", "--selected"],
      leadingDashValues: ["--description", "--title"],
      repeatable: ["--co-author", "--commit", "--range"],
      values: ["--author", "--author-date", "--committer", "--committer-date", "--description", "--title", "--worktree"],
    });
    return {
      author: flags.optional("--author") ?? undefined,
      authorDate: flags.optional("--author-date") ?? undefined,
      clearCoAuthors: flags.has("--no-co-authors"),
      coAuthors: flags.values.get("--co-author") ?? [],
      commits: flags.values.get("--commit") ?? [],
      committer: flags.optional("--committer") ?? undefined,
      committerDate: flags.optional("--committer-date") ?? undefined,
      description: flags.optional("--description") ?? "",
      includeSelection: flags.has("--selected"),
      ranges: flags.values.get("--range") ?? [],
      targetWorktree: flags.optional("--worktree") ?? undefined,
      title: flags.optional("--title") ?? undefined,
    };
  },
  buildRequest(input, { callerThreadId, cwd }) {
    const description = input.description.trim();
    return postWorkbenchAgentCommand("/api/git", {
      action: "amend",
      ...(input.author ? { author: input.author } : {}),
      ...(input.authorDate ? { authorDate: input.authorDate } : {}),
      clearCoAuthors: input.clearCoAuthors,
      coAuthors: input.coAuthors,
      commits: input.commits,
      ...(input.committer ? { committer: input.committer } : {}),
      ...(input.committerDate ? { committerDate: input.committerDate } : {}),
      cwd,
      includeSelection: input.includeSelection,
      ...(input.title ? { message: description ? `${input.title}\n\n${description}` : input.title } : {}),
      ranges: input.ranges,
      ...(input.targetWorktree ? { targetWorktree: input.targetWorktree } : {}),
      threadId: requireCallerThreadId(callerThreadId),
    });
  },
});

export const WORKBENCH_GIT_COMMANDS = [selectionCommand("add"), selectionCommand("unstage"), commit, amend] as const;
