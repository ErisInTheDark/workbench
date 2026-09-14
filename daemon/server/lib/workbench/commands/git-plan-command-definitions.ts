/*
 * Keywords: git, plan, claims, CLI, MCP.
 * Exports:
 * - WORKBENCH_GIT_PLAN_COMMANDS: create, revise or atomically activate explicit plan scope.
 */
import { GitArcPlanClaimsSchema } from "workbench-shared/workbench/git/checkpoint-contracts";
import { parseGitClaimArguments } from "workbench-shared/workbench/git/git-claim-arguments";
import { defineWorkbenchAgentCommand, managedWorkbenchAgentCommandBody, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

function planCommand(start: boolean) {
  return defineWorkbenchAgentCommand({
    description: start
      ? "Create and activate approved scope atomically. Inherit to revise existing scope and intent."
      : "Publish inactive scope and report changes since the previous plan. Inherit to retain scope and intent. Adoption is explicit.",
    helpGroups: ["git-arc"],
    words: ["git", "plan", start ? "start" : "claims"],
    usage: `wb git plan ${start ? "start" : "claims"} [-m <intent>] [--inherit] [-- <add-path> -<remove-path> '*<adopt-path>'...]`,
    inputSchema: GitArcPlanClaimsSchema,
    parseCliArgs: (args) => parseGitClaimArguments(args, true),
    buildRequest(input, context) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        ...managedWorkbenchAgentCommandBody(context),
        action: "planClaims", start, inherit: input.inherit,
        addPaths: input.addPaths, removePaths: input.removePaths, adoptPaths: input.adoptPaths, roots: input.roots,
        ...(input.intentName ? { intentName: input.intentName } : {}),
        ...(input.intentDescription !== undefined ? { intentDescription: input.intentDescription } : {}),
      }, start ? "git-arc-start" : "git-arc-plan");
    },
  });
}

export const WORKBENCH_GIT_PLAN_COMMANDS = [planCommand(false), planCommand(true)] as const;
