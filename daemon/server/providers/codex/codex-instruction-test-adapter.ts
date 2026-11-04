/*
 * Exports:
 * - createTestCodexInstructionAdapter: a Codex instruction adapter over a real instruction builder with the static tool catalogue,
 *   no local capabilities and no pinning, for tests. Import it dynamically after setting the test library root.
 */
import { listWorkbenchAgentCommands } from "../../lib/workbench/commands/workbench-agent-command-registry";
import { listWorkbenchInstructionTools } from "../../lib/workbench/instructions/instruction-tool-reference";
import WorkbenchThreadInstructionBuilder from "../../thread/WorkbenchThreadInstructionBuilder";
import WorkbenchCodexInstructionAdapter from "./WorkbenchCodexInstructionAdapter";

export function createTestCodexInstructionAdapter(bridgeUrl: string, workbenchRoot: string) {
  return new WorkbenchCodexInstructionAdapter(bridgeUrl, workbenchRoot, new WorkbenchThreadInstructionBuilder({
    readRoots: async () => [],
    readInstructionTools: async () => listWorkbenchInstructionTools(listWorkbenchAgentCommands()),
    readLocalCapabilities: async () => ({ browseRawCommandsEnabled: false }),
    workbenchOrigin: "http://127.0.0.1:4500",
    pin: async () => undefined,
  }));
}
