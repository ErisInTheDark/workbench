/*
 * Exports:
 * - WORKBENCH_ORCHESTRATOR_COMMANDS: typed orchestrator lifecycle command definitions shared by CLI and MCP. Keywords: workbench, orchestrator, reload, commands.
 */
import { z } from "zod";

import {
  expandOrchestratorReloadScopes,
  ORCHESTRATOR_ALL_RELOAD_SCOPES,
  ORCHESTRATOR_REQUESTABLE_RELOAD_SCOPES,
} from "../orchestrator-reload";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

function buildReloadRequest(scopes: readonly string[], context: { callerHarness: string; callerThreadId: string | null; cwd: string }) {
  return {
    ...postWorkbenchAgentCommand("/api/orchestrator/reload", {
      ...(context.callerThreadId ? {
        callerHarness: context.callerHarness,
        callerThreadId: context.callerThreadId,
        cwd: context.cwd,
      } : {}),
      scopes: [...scopes],
    }, "orchestrator-reload"),
    waitForReload: true,
  } as const;
}

function parseReloadCliSelections(args: string[]) {
  if (!args.length) return { hard: false, scopes: [] as string[] };
  const selections: string[] = [];
  let hard = false;
  for (const argument of args) {
    if (!argument.startsWith("--") || argument === "--") throw new Error(`Unexpected argument: ${argument}`);
    if (argument === "--hard") {
      hard = true;
    } else if (argument === "--all") {
      selections.push(...ORCHESTRATOR_ALL_RELOAD_SCOPES);
    } else if (argument === "--server:process") {
      throw new Error("server:process is only available through --hard.");
    } else {
      selections.push(argument.slice(2));
    }
  }
  return { hard, scopes: selections };
}

const requestableReloadScopes = z.array(z.enum(ORCHESTRATOR_REQUESTABLE_RELOAD_SCOPES)).min(1);
const reloadInput = z.object({
  scopes: requestableReloadScopes,
}).strict();

const documentedReload = defineWorkbenchAgentCommand({
  description: "Reload selected Workbench runtime subsystems and wait for terminal reload status.",
  helpGroups: ["orchestrator"],
  words: ["orchestrator", "reload"],
  usage: "wb orchestrator reload --<scope> [--<scope> ...]",
  inputSchema: reloadInput,
  parseCliArgs(args) {
    const parsed = parseReloadCliSelections(args);
    if (parsed.hard) throw new Error("--hard must be requested by itself.");
    return { scopes: requestableReloadScopes.parse(expandOrchestratorReloadScopes(parsed.scopes)) };
  },
  buildRequest(input, context) {
    return buildReloadRequest(input.scopes, context);
  },
});

const reload = {
  ...documentedReload,
  async buildRequestFromCli(args, context) {
    const parsed = parseReloadCliSelections(args);
    if (!parsed.hard) return await documentedReload.buildRequestFromCli(args, context);
    if (args.length !== 1) throw new Error("--hard must be requested by itself.");
    return buildReloadRequest(["server:process"], context);
  },
};

export const WORKBENCH_ORCHESTRATOR_COMMANDS = [reload] as const;
