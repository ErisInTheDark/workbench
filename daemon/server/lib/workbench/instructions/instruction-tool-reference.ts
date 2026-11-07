/*
 * Exports:
 * - WorkbenchInstructionTool: a Workbench tool an agent can use, with its MCP exposure and code-mode eligibility.
 * - WorkbenchToolReference: how one provider names a preloaded tool, and whether that name is called as code or as a tool.
 * - listWorkbenchInstructionTools: the instruction catalogue for command definitions, including deferred and capability-gated commands.
 * - selectWorkbenchInstructionTools: the catalogue one caller's `<docs>` gates and tool references see.
 * - resolveWorkbenchToolReference: name a preloaded MCP tool for one provider.
 * - renderWorkbenchToolReferences: rewrite agent message tool markup into one recipient's own calls.
 * - listWorkbenchInstructionToolFamily: catalogued ids a `<docs>` gate id covers, itself and its `id_*` subtools.
 * - servesWorkbenchInstructionTool: whether an agent can use a tool or any of its `id_*` subtools, through MCP or CLI, for `<docs>` gates.
 */
import type { WorkbenchHarness, WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import { WORKBENCH_MCP_SERVER_NAME } from "workbench-shared/workbench/mcp/mcp-server-settings";
import { WORKBENCH_SHELL_MCP_TOOL_NAME } from "workbench-shared/workbench/commands/workbench-shell-command";
import {
  getWorkbenchAgentCommandToolName,
  isWorkbenchAgentCommandOnMcp,
  type WorkbenchAgentCommandDefinition,
  type WorkbenchCommandAudienceRule,
} from "../commands/workbench-agent-command-definition";
import { refuseWorkbenchTool, type WorkbenchCommandAudience } from "../commands/workbench-command-audience";
import { replaceWorkbenchToolReferences } from "./tool-reference-markup";

/** Carries its command's audience rule, so catalogue readers apply the same visibility as MCP and CLI. */
export interface WorkbenchInstructionTool extends WorkbenchCommandAudienceRule {
  readonly id: string;
  readonly codeModeEligible: boolean;
  /** Not preloaded: reached through the `wb` CLI or `mcp_call` on server `wb`, so no direct MCP name exists to reference. */
  readonly deferred?: boolean;
  /** Set only for commands the MCP server never offers: the `wb` command line that runs them. */
  readonly cliCommand?: string;
}

export interface WorkbenchToolReference {
  readonly name: string;
  readonly invocation: "call" | "tool";
}

const MCP_CALL_TOOL_ID = "mcp_call";

export function listWorkbenchInstructionTools(definitions: readonly WorkbenchAgentCommandDefinition[]): WorkbenchInstructionTool[] {
  return [
    { id: WORKBENCH_SHELL_MCP_TOOL_NAME, codeModeEligible: true },
    ...definitions.map(definition => ({
      id: getWorkbenchAgentCommandToolName(definition),
      codeModeEligible: definition.mcpCodeModeEligible === true,
      ...(definition.mcpDeferred ? { deferred: true } : {}),
      ...(isWorkbenchAgentCommandOnMcp(definition) ? {} : { cliCommand: `wb ${definition.words.join(" ")}` }),
      ...(definition.audience?.harnesses ? { harnesses: definition.audience.harnesses } : {}),
      ...(definition.audience?.rootOnly ? { rootOnly: true as const } : {}),
      ...(definition.audience?.requiresCapability ? { requiresCapability: definition.audience.requiresCapability } : {}),
    })),
  ];
}

/** Prompt context does not know the Workbench root, so root-only tools keep their docs. */
export function selectWorkbenchInstructionTools(
  catalogue: readonly WorkbenchInstructionTool[],
  caller: Pick<WorkbenchCommandAudience, "harness" | "subagent">,
  capabilities: WorkbenchLocalCapabilitySettings,
) {
  const audience = { ...caller, workbenchRoot: true, capabilities };
  return catalogue.filter(tool => refuseWorkbenchTool(tool.id, tool, audience) === null);
}

export function resolveWorkbenchToolReference(
  id: string,
  harness: WorkbenchHarness,
  catalogue: readonly WorkbenchInstructionTool[],
): WorkbenchToolReference | null {
  const tool = catalogue.find(candidate => candidate.id === id);
  if (!tool || tool.deferred) return null;
  if (harness === "codex") {
    const namespace = tool.codeModeEligible ? "wb" : "wbex";
    return { name: `tools.mcp__${namespace}__${id}`, invocation: "call" };
  }
  if (harness === "opencode") {
    return tool.codeModeEligible ? { name: `tools.wb.${id}`, invocation: "call" } : { name: `wbex_${id}`, invocation: "tool" };
  }
  if (harness === "claude") return { name: `mcp__wb__${id}`, invocation: "tool" };
  return null;
}

function formatToolCall(reference: WorkbenchToolReference, args: string | null) {
  if (args === null) return `\`${reference.name}\``;
  return reference.invocation === "call" ? `\`${reference.name}(${args})\`` : `\`${reference.name}\` with \`${args}\``;
}

function renderToolReference(id: string, args: string | null, harness: WorkbenchHarness, catalogue: readonly WorkbenchInstructionTool[]) {
  const tool = catalogue.find(candidate => candidate.id === id);
  if (tool?.cliCommand) return formatToolCall({ name: tool.cliCommand, invocation: "tool" }, args);
  if (tool?.deferred) {
    const mcpCall = resolveWorkbenchToolReference(MCP_CALL_TOOL_ID, harness, catalogue);
    const callArgs = `{"server":${JSON.stringify(WORKBENCH_MCP_SERVER_NAME)},"tool":${JSON.stringify(id)}${args === null ? "" : `,"arguments":${args}`}}`;
    if (mcpCall) return formatToolCall(mcpCall, callArgs);
  }
  const reference = tool ? resolveWorkbenchToolReference(id, harness, catalogue) : null;
  return reference ? formatToolCall(reference, args) : `\`${id}\` (unavailable to you)`;
}

/** Senders check ids against their own daemon; ids this recipient cannot use, such as from a newer daemon, stay named instead of failing delivery. */
export function renderWorkbenchToolReferences(text: string, harness: WorkbenchHarness, catalogue: readonly WorkbenchInstructionTool[]) {
  return replaceWorkbenchToolReferences(text, ({ id, args }) => renderToolReference(id, args, harness, catalogue));
}

export function listWorkbenchInstructionToolFamily(id: string, catalogue: readonly WorkbenchInstructionTool[]) {
  return catalogue.filter(tool => tool.id === id || tool.id.startsWith(`${id}_`)).map(tool => tool.id);
}

export function servesWorkbenchInstructionTool(id: string, catalogue: readonly WorkbenchInstructionTool[]) {
  return listWorkbenchInstructionToolFamily(id, catalogue).length > 0;
}
