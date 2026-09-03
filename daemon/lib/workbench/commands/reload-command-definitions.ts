/*
 * Exports:
 * - createWorkbenchReloadCommands: build hidden user-owned reload and dirt CLI contracts from the live dirt catalog. Keywords: reload, dirt, CLI, hidden.
 */
import { z } from "zod";

import type { OrchestratorReloadScope } from "workbench-shared/types";
import {
  expandOrchestratorReloadScopes,
  type OrchestratorReloadScopeDescriptor,
  resolveOrchestratorReloadSelections,
} from "workbench-shared/workbench/orchestrator-reload";
import { defineWorkbenchAgentCommand, getWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

type ReloadAccess = OrchestratorReloadScopeDescriptor["access"];

function buildReloadRequest(input: { all?: boolean; scopes?: readonly OrchestratorReloadScope[]; unsafe?: boolean }) {
  return {
    ...postWorkbenchAgentCommand("/api/orchestrator/reload", {
      ...(input.all ? { all: true } : {}),
      ...(input.scopes?.length ? { scopes: [...input.scopes] } : {}),
      ...(input.unsafe ? { unsafe: true } : {}),
    }, "orchestrator-reload"),
    waitForReload: true,
  } as const;
}

function parseReloadCliSelections(args: string[]) {
  const selections: string[] = [];
  let all = false;
  let hard = false;
  let unsafe = false;
  for (const argument of args) {
    if (!argument.startsWith("--") || argument === "--") throw new Error(`Unexpected argument: ${argument}`);
    if (argument === "--hard") hard = true;
    else if (argument === "--all") all = true;
    else if (argument === "--unsafe") unsafe = true;
    else if (argument === "--server:process") throw new Error("server:process is only available through --hard.");
    else selections.push(argument.slice(2));
  }
  return { all, hard, selections, unsafe };
}

export function createWorkbenchReloadCommands(catalog: readonly OrchestratorReloadScopeDescriptor[], access: ReloadAccess) {
  const allowedScopeValues = catalog
    .filter((entry) => access === "operator" || entry.access !== "operator" || entry.scope === "server:process")
    .map((entry) => entry.scope);
  const scopeSchema = allowedScopeValues.length
    ? z.enum(allowedScopeValues as [string, ...string[]])
    : z.string().refine(() => false, "No reload scopes are available.");
  const reloadInput = z.object({
    all: z.boolean().optional(),
    scopes: z.array(scopeSchema).max(64).optional(),
    unsafe: z.boolean().optional(),
  }).strict();
  const reload = defineWorkbenchAgentCommand({
    description: "Reload selected Workbench runtime scopes with user permission.",
    helpGroups: ["reload"],
    hideFromMcp: true,
    hideFromRootHelp: true,
    inputSchema: reloadInput,
    usage: "wb reload [--all [--unsafe] | --<scope> ... | --hard]",
    words: ["reload"],
    parseCliArgs(args) {
      const parsed = parseReloadCliSelections(args);
      if (parsed.hard) {
        if (args.length !== 1) throw new Error("--hard must be requested by itself.");
        return { scopes: ["server:process"] };
      }
      if (parsed.unsafe && !parsed.all) throw new Error("--unsafe is only available with --all.");
      const scopes = parsed.selections.length ? expandOrchestratorReloadScopes(parsed.selections) : undefined;
      resolveOrchestratorReloadSelections({ all: parsed.all, scopes, unsafe: parsed.unsafe }, catalog, access);
      return { ...(parsed.all ? { all: true } : {}), ...(scopes?.length ? { scopes } : {}), ...(parsed.unsafe ? { unsafe: true } : {}) };
    },
    buildRequest(input) { return buildReloadRequest(input); },
  });
  const dirt = defineWorkbenchAgentCommand({
    description: "List reload scopes required by the current workspace dirt.",
    helpGroups: [],
    hideFromMcp: true,
    hideFromRootHelp: true,
    inputSchema: z.object({}).strict(),
    usage: "wb dirt",
    words: ["dirt"],
    parseCliArgs(args) {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      return {};
    },
    buildRequest() { return getWorkbenchAgentCommand("/api/orchestrator/dirt", "reload-dirt"); },
  });
  return [reload, dirt] as const;
}
