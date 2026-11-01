/*
 * Exports:
 * - readWorkbenchModeGates: the mode entry gates a thread's selected workflows declare.
 */
import type { ModeGate } from "workbench-shared/workbench/thread/workflow-modes";
import { ensureWorkbenchLibrary } from "../../workbench-library";
import { collectWorkbenchInstructionModeGates } from "./instruction-context-filter";
import { createLibraryInstructionFileGeneration } from "./library-instruction-files";

/** Workflow keys match case-insensitively, as prompt assembly selects them; the first gate declared for a mode wins. */
export async function readWorkbenchModeGates(workflowIds: readonly string[]): Promise<ModeGate[]> {
  await ensureWorkbenchLibrary();
  const selected = new Set(workflowIds.map(id => id.trim().toLowerCase()));
  const instructionFiles = createLibraryInstructionFileGeneration();
  const gates = new Map<string, ModeGate>();
  for (const workflow of instructionFiles.list("wb/workflows").filter(candidate => selected.has(candidate.key))) {
    for (const gate of collectWorkbenchInstructionModeGates(instructionFiles.render(workflow.relativePath))) {
      const key = gate.mode.toLowerCase();
      if (gates.has(key)) console.warn(`[mode-gates] Mode ${gate.mode} is gated more than once; the first gate wins.`);
      else gates.set(key, gate);
    }
  }
  return [...gates.values()];
}
