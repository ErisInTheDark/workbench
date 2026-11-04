/*
 * Exports:
 * - OpenCodeManagedSessionContext: provider-local instruction refresh input.
 * - OpenCodeManagedSessionControllerOptions: injectable managed-session boundaries.
 * - default OpenCodeManagedSessionController: own OpenCode session marking, native command and per-audience tool denial, and placing
 *   Workbench-built instructions as the session's instruction entry.
 */
import type { WorkbenchInstructionTool } from "../../lib/workbench/instructions/instruction-tool-reference";
import { WORKBENCH_PARENT_ONLY_TOOLS } from "workbench-shared/workbench/commands/workbench-tool-audience";
import { isSamePath } from "workbench-shared/same-path";
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";
import { OPENCODE_WORKBENCH_DIRECT_NAMESPACE, OPENCODE_WORKBENCH_NAMESPACE } from "./opencode-workbench-rpc";
import type WorkbenchThreadInstructionBuilder from "../../thread/WorkbenchThreadInstructionBuilder";

const NATIVE_COMMAND_ACTIONS = ["bash", "shell"] as const;
// A tool's permission action is its effective name, which carries its code-mode or direct namespace.
const toolActions = (ids: readonly string[]) => ids.flatMap(id =>
  [OPENCODE_WORKBENCH_NAMESPACE, OPENCODE_WORKBENCH_DIRECT_NAMESPACE].map(namespace => `${namespace}_${id}`));
const PARENT_ONLY_ACTIONS = toolActions(WORKBENCH_PARENT_ONLY_TOOLS);

/** `rootOnlyTools` are denied outside the Workbench repository root. */
function managedPermissions({ subagent = false, rootOnlyTools = [] }: { subagent?: boolean; rootOnlyTools?: readonly string[] } = {}) {
  return [
    ...NATIVE_COMMAND_ACTIONS,
    ...(subagent ? PARENT_ONLY_ACTIONS : []),
    ...toolActions(rootOnlyTools),
  ].map(action => ({
    action,
    resource: "*",
    effect: "deny" as const,
  }));
}

export interface OpenCodeManagedSessionContext {
  sessionID: string;
  cwd: string;
  projectId: string;
  threadId: string;
  model: string | null;
  agentPath: string | null;
  workflowIds: readonly string[];
  subagentName?: string | null;
}

export interface OpenCodeManagedSessionControllerOptions {
  acquire: () => Promise<WorkbenchOpenCodeClient>;
  /** Builds and pins the thread's instructions. */
  instructions: Pick<WorkbenchThreadInstructionBuilder, "build">;
  readInstructionTools: () => Promise<readonly WorkbenchInstructionTool[]>;
  /** Workbench repository root; sessions elsewhere are denied its root-only tools. */
  workbenchRoot: string;
}

export default class OpenCodeManagedSessionController {
  constructor(private readonly options: OpenCodeManagedSessionControllerOptions) {}

  creation() {
    return {
      metadata: { workbench: { managed: true, provider: "opencode", version: 1 } },
      permissions: managedPermissions(),
    };
  }

  /** Replace the session's managed instructions and per-audience permissions before a prompt. */
  async refresh(input: OpenCodeManagedSessionContext) {
    const built = await this.options.instructions.build({
      harness: "opencode", model: input.model, threadId: input.threadId, projectId: input.projectId, cwd: input.cwd,
      agentPath: input.agentPath, workflowIds: input.workflowIds, subagentName: input.subagentName,
    });
    const value = [built.baseInstructions, built.developerInstructions]
      .filter((part): part is string => Boolean(part?.trim())).join("\n\n");
    const session = (await this.options.acquire()).session;
    await session.update({
      sessionID: input.sessionID,
      permissions: managedPermissions({
        subagent: Boolean(input.subagentName),
        rootOnlyTools: isSamePath(input.cwd, this.options.workbenchRoot) ? [] : await this.directRootOnlyTools(),
      }),
    });
    await session.instructions.entry.put({ sessionID: input.sessionID, key: "workbench", value });
  }

  /** Deferred root-only tools run through `mcp_call`, which the MCP server gates per caller instead. */
  private async directRootOnlyTools() {
    return (await this.options.readInstructionTools()).filter(tool => tool.rootOnly && !tool.deferred).map(tool => tool.id);
  }
}
