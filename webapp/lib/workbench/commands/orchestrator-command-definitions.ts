/*
 * Exports:
 * - createWorkbenchOrchestratorCommands: build reload CLI and MCP contracts from the active topology catalog. Keywords: orchestrator, reload, dynamic, catalog.
 */
import { z } from "zod";

import type { OrchestratorReloadScope } from "../../types";
import {
  expandOrchestratorReloadScopes,
  type OrchestratorReloadScopeDescriptor,
  resolveOrchestratorReloadSelections,
} from "../orchestrator-reload";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

type ReloadAccess = OrchestratorReloadScopeDescriptor["access"];

function buildReloadRequest(input: { all?: boolean; scopes?: readonly OrchestratorReloadScope[] }, context: { callerHarness: string; callerThreadId: string | null; cwd: string }) {
  return {
    ...postWorkbenchAgentCommand("/api/orchestrator/reload", {
      ...(context.callerThreadId ? {
        callerHarness: context.callerHarness,
        callerThreadId: context.callerThreadId,
        cwd: context.cwd,
      } : {}),
      ...(input.all ? { all: true } : {}),
      ...(input.scopes?.length ? { scopes: [...input.scopes] } : {}),
    }, "orchestrator-reload"),
    waitForReload: true,
  } as const;
}

function parseReloadCliSelections(args: string[]) {
  if (!args.length) return { all: false, hard: false, selections: [] as string[] };
  const selections: string[] = [];
  let all = false;
  let hard = false;
  for (const argument of args) {
    if (!argument.startsWith("--") || argument === "--") throw new Error(`Unexpected argument: ${argument}`);
    if (argument === "--hard") hard = true;
    else if (argument === "--all") all = true;
    else if (argument === "--server:process") throw new Error("server:process is only available through --hard.");
    else selections.push(argument.slice(2));
  }
  return { all, hard, selections };
}

function canAccess(entry: OrchestratorReloadScopeDescriptor, access: ReloadAccess) {
  return access === "operator" || entry.access === "agent" || (access === "cli" && entry.access === "cli");
}

export function createWorkbenchOrchestratorCommands(
  catalog: readonly OrchestratorReloadScopeDescriptor[],
  access: ReloadAccess,
) {
  const allowedScopeValues = catalog.filter((entry) => canAccess(entry, access)).map((entry) => entry.scope);
  const scopeSchema = allowedScopeValues.length
    ? z.enum(allowedScopeValues as [string, ...string[]])
    : z.string().refine(() => false, "No reload scopes are available.");
  const scopesSchema = z.array(scopeSchema).max(64);
  const reloadInput = z.object({
    all: z.boolean().optional(),
    scopes: scopesSchema.optional(),
  }).strict().refine((input) => input.all || input.scopes?.length, "At least one supported reload scope is required.");

  const documentedReload = defineWorkbenchAgentCommand({
    description: "Reload selected Workbench runtime subsystems and wait for terminal reload status.",
    helpGroups: ["orchestrator"],
    mcpSteerInterruptible: true,
    words: ["orchestrator", "reload"],
    usage: "wb orchestrator reload --<scope> [--<scope> ...]",
    inputSchema: reloadInput,
    parseCliArgs(args) {
      const parsed = parseReloadCliSelections(args);
      if (parsed.hard) throw new Error("--hard must be requested by itself.");
      const scopes = parsed.selections.length ? scopesSchema.parse(expandOrchestratorReloadScopes(parsed.selections)) : undefined;
      resolveOrchestratorReloadSelections({ all: parsed.all, scopes }, catalog, access);
      return { ...(parsed.all ? { all: true } : {}), ...(scopes?.length ? { scopes } : {}) };
    },
    buildRequest(input, context) {
      return buildReloadRequest(input, context);
    },
  });

  const reload = {
    ...documentedReload,
    async buildRequestFromCli(args: string[], context: Parameters<typeof buildReloadRequest>[1]) {
      const parsed = parseReloadCliSelections(args);
      if (parsed.hard) {
        if (args.length !== 1 || access === "agent") throw new Error("--hard must be requested by itself.");
        return buildReloadRequest({ scopes: ["server:process"] }, context);
      }
      const scopes = parsed.selections.length ? scopesSchema.parse(expandOrchestratorReloadScopes(parsed.selections)) : undefined;
      resolveOrchestratorReloadSelections({ all: parsed.all, scopes }, catalog, access);
      return buildReloadRequest({ ...(parsed.all ? { all: true } : {}), ...(scopes?.length ? { scopes } : {}) }, context);
    },
  };

  return [reload] as const;
}
