/*
 * Keywords: git, proposal, amend, replace, reword, CLI, MCP.
 * Exports:
 * - WORKBENCH_GIT_ARC_PROPOSAL_COMMANDS: explicit content proposals and message-only proposals.
 */
import { z } from "zod";
import { gitArcRejectionIssue } from "workbench-shared/workbench/git/git-arc-rejections";
import { preservePowerShellTrailingPaths, WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const text = z.string().trim().min(1);
const proposalInput = z.object({
  amend: z.union([z.boolean(), text]).default(false),
  amendProposalId: text.optional(),
  replace: text.optional(),
  replaceProposalId: text.optional(),
  title: z.string().default(""),
  description: z.string().default(""),
  freshTitle: text.optional(),
  freshDescription: z.string().optional(),
  paths: z.array(text).default([]),
  rootId: text.optional(),
}).strict().superRefine((input, context) => {
  const replace = input.replace ?? input.replaceProposalId;
  const contentAmend = Boolean(input.amend) || Boolean(input.amendProposalId && input.paths.length);
  if ((input.amend || input.amendProposalId) && replace) context.addIssue(gitArcRejectionIssue({ reason: "conflictingProposalTargets" }, "replace and amend cannot be combined."));
  if (input.replace && input.replaceProposalId && input.replace !== input.replaceProposalId) {
    context.addIssue(gitArcRejectionIssue({ reason: "conflictingReplacementTargets" }, "Supply one replacement target."));
  }
  if (typeof input.amend === "string" && input.amendProposalId && input.amend !== input.amendProposalId) {
    context.addIssue(gitArcRejectionIssue({ reason: "conflictingAmendmentTargets" }, "Supply one amendment target."));
  }
  if (!contentAmend && !input.title.trim()) context.addIssue(gitArcRejectionIssue({ reason: "missingCommitTitle" }, "title is required unless amending content."));
  if (contentAmend && !input.freshTitle) context.addIssue(gitArcRejectionIssue({ reason: "missingFreshTitle" }, "Content amendments require freshTitle. Use reword for message-only changes."));
  if (!contentAmend && (input.freshTitle !== undefined || input.freshDescription !== undefined)) {
    context.addIssue(gitArcRejectionIssue({ reason: "unexpectedFreshMetadata" }, "Fresh commit metadata requires content amendment."));
  }
});

const propose = defineWorkbenchAgentCommand({
  description: "Propose claimed changes. Replace a pending proposal, or amend a committed proposal with a separate fresh-commit choice.",
  helpGroups: ["git-arc"], words: ["git", "arc", "propose"],
  usage: "wb git arc propose [--root <root>] [--amend [<proposal-id>] --fresh-title <title> [--fresh-description <description>]] [--replace <proposal-id>] [--title <title>] [--description <description>] [-- <path>...]",
  inputSchema: proposalInput,
  parseCliArgs(args) {
    const normalized = [...args];
    const amendIndex = normalized.indexOf("--amend");
    let target: string | undefined;
    if (amendIndex >= 0 && normalized[amendIndex + 1] && !normalized[amendIndex + 1]!.startsWith("-")) {
      target = normalized[amendIndex + 1];
      normalized.splice(amendIndex + 1, 1);
    }
    const values = ["--description", "--fresh-description", "--fresh-title", "--replace", "--root", "--title"];
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(normalized, { boolean: ["--amend"], values }), {
      boolean: ["--amend"], values, trailing: true,
      leadingDashValues: ["--description", "--fresh-description", "--fresh-title", "--title"],
    });
    return {
      amend: target ?? flags.has("--amend"),
      replace: flags.optional("--replace") ?? undefined,
      title: flags.optional("--title") ?? "",
      description: flags.optional("--description") ?? "",
      freshTitle: flags.optional("--fresh-title") ?? undefined,
      freshDescription: flags.optional("--fresh-description") ?? undefined,
      rootId: flags.optional("--root") ?? undefined,
      paths: flags.trailing,
    };
  },
  buildRequest(input, context) {
    const amendProposalId = typeof input.amend === "string" ? input.amend : input.amendProposalId;
    const replaceProposalId = input.replace ?? input.replaceProposalId;
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...managedWorkbenchAgentCommandBody(context), action: "proposalCreate",
      amend: Boolean(input.amend) || Boolean(input.amendProposalId && input.paths.length), title: input.title, description: input.description,
      ...(amendProposalId ? { amendProposalId } : {}),
      ...(replaceProposalId ? { replaceProposalId } : {}),
      ...(input.freshTitle ? { freshTitle: input.freshTitle } : {}),
      ...(input.freshDescription !== undefined ? { freshDescription: input.freshDescription } : {}),
      ...(input.paths.length ? { paths: input.paths } : {}),
      ...(input.rootId ? { rootId: input.rootId } : {}),
    }, "git-arc-propose");
  },
});

const reword = defineWorkbenchAgentCommand({
  description: "Propose only a committed proposal's message change. Includes no workspace content and does not commit.",
  helpGroups: ["git-arc"], words: ["git", "arc", "reword"],
  usage: "wb git arc reword --proposal <id> --title <title> [--description <description>] [--root <root>]",
  inputSchema: z.object({ proposalId: text, title: text, description: z.string().default(""), rootId: text.optional() }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, {
      values: ["--proposal", "--title", "--description", "--root"], leadingDashValues: ["--title", "--description"],
    });
    return {
      proposalId: flags.required("--proposal"), title: flags.required("--title"),
      description: flags.optional("--description") ?? "", rootId: flags.optional("--root") ?? undefined,
    };
  },
  buildRequest(input, context) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...managedWorkbenchAgentCommandBody(context), action: "proposalCreate",
      amend: false, amendProposalId: input.proposalId, title: input.title, description: input.description,
      ...(input.rootId ? { rootId: input.rootId } : {}),
    }, "git-arc-propose");
  },
});

export const WORKBENCH_GIT_ARC_PROPOSAL_COMMANDS = [propose, reword] as const;
