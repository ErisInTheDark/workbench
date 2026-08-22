/*
 * Exports:
 * - WORKBENCH_ORCHESTRATOR_COMMANDS: typed orchestrator lifecycle command definitions shared by CLI and MCP. Keywords: workbench, orchestrator, reload, commands.
 */
import { z } from "zod";

import { ORCHESTRATOR_ALL_RELOAD_SCOPES } from "../orchestrator-reload";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const RELOAD_SWITCHES = [
  "--orchestrator-logic",
  "--browse-controller",
  "--codex-bridge",
  "--mcp",
  "--opencode-bridge",
  "--opencode-server",
  "--next-dev",
] as const;

const reloadScope = z.enum([
  "orchestrator-logic",
  "browse-controller",
  "codex-bridge",
  "mcp",
  "opencode-bridge",
  "opencode-server",
  "next-dev",
]);

function buildReloadRequest(scopes: readonly string[]) {
  return {
    ...postWorkbenchAgentCommand("/api/orchestrator/reload", { scopes: [...scopes] }, "orchestrator-reload"),
    waitForReload: true,
  } as const;
}

const documentedReload = defineWorkbenchAgentCommand({
  description: "Reload selected Workbench runtime subsystems and wait for terminal reload status.",
  helpGroups: ["orchestrator"],
  words: ["orchestrator", "reload"],
  usage: "wb orchestrator reload [--all] [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--mcp] [--opencode-bridge] [--opencode-server] [--next-dev]",
  inputSchema: z.object({ scopes: z.array(reloadScope).min(1) }).strict().superRefine(({ scopes }, context) => {
    if (new Set(scopes).size !== scopes.length) context.addIssue({ code: "custom", message: "Reload scopes must be unique." });
  }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: [...RELOAD_SWITCHES, "--all"] });
    const selectedOrdinaryFlags = RELOAD_SWITCHES.filter((flag) => flags.has(flag));
    return {
      scopes: Array.from(new Set([
        ...(flags.has("--all") ? ORCHESTRATOR_ALL_RELOAD_SCOPES : []),
        ...selectedOrdinaryFlags.map((flag) => flag.slice(2) as z.output<typeof reloadScope>),
      ])),
    };
  },
  buildRequest(input) {
    return buildReloadRequest(input.scopes);
  },
});

const reload = {
  ...documentedReload,
  async buildRequestFromCli(args, context) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: [...RELOAD_SWITCHES, "--all", "--hard"] });
    const selectedOrdinaryFlags = RELOAD_SWITCHES.filter((flag) => flags.has(flag));
    if (!flags.has("--hard")) return await documentedReload.buildRequestFromCli(args, context);
    if (flags.has("--all") || selectedOrdinaryFlags.length) throw new Error("--hard must be requested by itself.");
    return buildReloadRequest(["orchestrator-server"]);
  },
};

export const WORKBENCH_ORCHESTRATOR_COMMANDS = [reload] as const;
