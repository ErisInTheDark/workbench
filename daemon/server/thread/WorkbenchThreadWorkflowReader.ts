/*
 * Exports:
 * - WorkbenchThreadWorkflowPorts: where one thread's instruction layers and workflow ledger come from.
 * - WorkbenchThreadWorkflow: a thread's resolved overlays, ledger, current mode and always-editable paths.
 * - default WorkbenchThreadWorkflowReader: own reading a thread's workflow state and the edit and tool denials its current mode imposes.
 */
import path from "node:path";
import type { WorkbenchInstructionSelection } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import {
  currentAlwaysEditable, currentWorkflowMode, findWorkflowMode, THREAD_STATE_TOOL,
  type WorkflowLedgerEntry, type WorkflowMode,
} from "workbench-shared/workbench/thread/workflow-modes";
import {
  readWorkbenchInstructionOverlays, type WorkbenchInstructionOverlays,
} from "../lib/workbench/instructions/instruction-overlay-catalogue";

export interface WorkbenchThreadWorkflowPorts {
  readSelection(threadId: string): Promise<WorkbenchInstructionSelection>;
  readSkills(threadId: string): Promise<readonly WorkbenchThreadSkill[]>;
  readProjectRoot(threadId: string): Promise<string | null>;
  readLedger(threadId: string): Promise<WorkflowLedgerEntry[]>;
  readOverlays?: typeof readWorkbenchInstructionOverlays;
}

export interface WorkbenchThreadWorkflow {
  overlays: WorkbenchInstructionOverlays;
  ledger: WorkflowLedgerEntry[];
  mode: string | null;
  definition: WorkflowMode | null;
  alwaysEditable: readonly string[];
  projectRoot: string | null;
}

const GIT_ARC_EDIT_TOOL_PREFIX = "git_arc_edit_";

function comparable(value: string) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

export default class WorkbenchThreadWorkflowReader {
  constructor(private readonly ports: WorkbenchThreadWorkflowPorts) {}

  async readOverlays(threadId: string) {
    const [selection, skills, projectRoot] = await Promise.all([
      this.ports.readSelection(threadId), this.ports.readSkills(threadId), this.ports.readProjectRoot(threadId),
    ]);
    const overlays = await (this.ports.readOverlays ?? readWorkbenchInstructionOverlays)({
      projectRoot,
      thread: { workflowIds: selection.workflowIds ?? [], skillPaths: skills.map(skill => skill.path) },
    });
    return { overlays, projectRoot };
  }

  async read(threadId: string): Promise<WorkbenchThreadWorkflow> {
    const [ledger, { overlays, projectRoot }] = await Promise.all([this.ports.readLedger(threadId), this.readOverlays(threadId)]);
    const mode = currentWorkflowMode(ledger);
    return { overlays, ledger, mode, definition: findWorkflowMode(overlays.modes, mode), alwaysEditable: currentAlwaysEditable(ledger), projectRoot };
  }

  /** Threads that never entered a mode skip resolving their instruction layers. */
  async #restrictions(threadId: string) {
    const ledger = await this.ports.readLedger(threadId);
    const mode = currentWorkflowMode(ledger);
    if (!mode) return null;
    const { overlays, projectRoot } = await this.readOverlays(threadId);
    const definition = findWorkflowMode(overlays.modes, mode);
    return definition?.deny.length ? { definition, alwaysEditable: currentAlwaysEditable(ledger), projectRoot } : null;
  }

  /** `edit` denies every requested path, `edit:claims` only claimed Git-visible ones; always-editable paths are exempt. */
  async readEditDenial(threadId: string, requested: readonly string[], claimed: readonly string[]) {
    const restrictions = await this.#restrictions(threadId);
    if (!restrictions) return null;
    const { definition, alwaysEditable, projectRoot } = restrictions;
    const scope = definition.deny.includes("edit") ? requested : definition.deny.includes("edit:claims") ? claimed : [];
    const exempt = new Set(alwaysEditable.map(entry => comparable(projectRoot ? path.resolve(projectRoot, entry) : entry)));
    const denied = scope.filter(candidate => !exempt.has(comparable(candidate)));
    if (!denied.length) return null;
    const what = definition.deny.includes("edit") ? "file edits" : "edits to Git-visible files";
    return `${definition.name} mode denies ${what}: ${denied.join(", ")}. Switch modes with ${THREAD_STATE_TOOL}, or list committed process notes in alwaysEditable.`;
  }

  /** thread_state can never be denied, so a denying mode can always be left; edit denials also cover Git arc edit sessions. */
  async readToolDenial(threadId: string, toolName: string) {
    if (toolName === THREAD_STATE_TOOL) return null;
    const restrictions = await this.#restrictions(threadId);
    const deny = restrictions?.definition.deny ?? [];
    const editTool = toolName.startsWith(GIT_ARC_EDIT_TOOL_PREFIX) && deny.some(token => token === "edit" || token === "edit:claims");
    if (!restrictions || (!deny.includes(toolName) && !editTool)) return null;
    return `${restrictions.definition.name} mode denies ${toolName}. Switch modes with ${THREAD_STATE_TOOL} first.`;
  }
}
