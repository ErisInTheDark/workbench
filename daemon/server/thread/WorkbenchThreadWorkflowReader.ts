/*
 * Exports:
 * - WorkbenchThreadWorkflowPorts: where one thread's instruction selection, skills, pinned instructions and workflow ledger come from.
 * - WorkbenchThreadWorkflow: a thread's resolved overlays, ledger, current mode and always-editable paths.
 * - default WorkbenchThreadWorkflowReader: own reading a thread's workflow state from the instructions it was given, and the edit and
 *   tool denials its current mode imposes.
 */
import path from "node:path";
import type { WorkbenchInstructionSelection } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import {
  currentAlwaysEditable, currentWorkflowMode, effectiveWorkflowMode, findWorkflowMode, THREAD_STATE_TOOL,
  type WorkflowLedgerEntry, type WorkflowMode,
} from "workbench-shared/workbench/thread/workflow-modes";
import {
  mergeWorkbenchInstructionLayers, readWorkbenchInstructionBaseLayers, readWorkbenchSkillLayers, type WorkbenchInstructionOverlays,
} from "../lib/workbench/instructions/instruction-overlay-catalogue";
import { comparableSkillPath, type PinnedInstructions } from "./WorkbenchThreadInstructionPins";

export interface WorkbenchThreadWorkflowPorts {
  readSelection(threadId: string): Promise<WorkbenchInstructionSelection>;
  readSkills(threadId: string): Promise<readonly WorkbenchThreadSkill[]>;
  readProjectRoot(threadId: string): Promise<string | null>;
  readLedger(threadId: string): Promise<WorkflowLedgerEntry[]>;
  readPins(threadId: string): Promise<PinnedInstructions>;
  readBaseLayers?: typeof readWorkbenchInstructionBaseLayers;
  readSkillLayers?: typeof readWorkbenchSkillLayers;
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
const GIT_ARC_WORKTREE_TOOLS: ReadonlySet<string> = new Set(["git_arc_restore", "git_arc_stash", "git_arc_unstash"]);

function comparable(value: string) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

export default class WorkbenchThreadWorkflowReader {
  constructor(private readonly ports: WorkbenchThreadWorkflowPorts) {}

  /**
   * Gates follow the instructions the thread was last given, so file edits apply from its next build. Pieces never pinned,
   * or stored in a shape this daemon no longer reads, come from current files. Skills follow the thread's activation order.
   */
  async readOverlays(threadId: string) {
    const [selection, skills, projectRoot, pinned] = await Promise.all([
      this.ports.readSelection(threadId), this.ports.readSkills(threadId), this.ports.readProjectRoot(threadId),
      this.ports.readPins(threadId),
    ]);
    const base = pinned.base
      ?? await (this.ports.readBaseLayers ?? readWorkbenchInstructionBaseLayers)({ projectRoot, workflowIds: selection.workflowIds ?? [] });
    const paths = skills.map(skill => skill.path);
    const missing = paths.filter(skillPath => !pinned.skills.has(comparableSkillPath(skillPath)));
    const live = missing.length ? await (this.ports.readSkillLayers ?? readWorkbenchSkillLayers)(projectRoot, missing) : [];
    const liveByPath = new Map(live.map(skill => [comparableSkillPath(skill.path), skill.layer]));
    const skillLayers = paths.flatMap((skillPath): WorkbenchInstructionOverlays[] => {
      const layer = pinned.skills.get(comparableSkillPath(skillPath)) ?? liveByPath.get(comparableSkillPath(skillPath));
      return layer ? [layer] : [];
    });
    return { overlays: mergeWorkbenchInstructionLayers([...base, ...skillLayers]), projectRoot };
  }

  async read(threadId: string): Promise<WorkbenchThreadWorkflow> {
    const [ledger, { overlays, projectRoot }] = await Promise.all([this.ports.readLedger(threadId), this.readOverlays(threadId)]);
    const mode = currentWorkflowMode(ledger);
    return { overlays, ledger, mode, definition: findWorkflowMode(overlays.modes, mode), alwaysEditable: currentAlwaysEditable(ledger), projectRoot };
  }

  /** Threads that skipped thread_state or sit in an undeclared mode follow the first declared mode's rules. */
  async #restrictions(threadId: string) {
    const [ledger, { overlays, projectRoot }] = await Promise.all([this.ports.readLedger(threadId), this.readOverlays(threadId)]);
    const definition = effectiveWorkflowMode(ledger, overlays.modes);
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

  /**
   * thread_state can never be denied, so a denying mode can always be left. Edit denials also cover Git arc tools that
   * write the worktree; `read` names native file-read tools.
   */
  async readToolDenial(threadId: string, toolName: string) {
    if (toolName === THREAD_STATE_TOOL) return null;
    const restrictions = await this.#restrictions(threadId);
    const deny = restrictions?.definition.deny ?? [];
    const editTool = (toolName.startsWith(GIT_ARC_EDIT_TOOL_PREFIX) || GIT_ARC_WORKTREE_TOOLS.has(toolName))
      && deny.some(token => token === "edit" || token === "edit:claims");
    if (!restrictions || (!deny.includes(toolName) && !editTool)) return null;
    return `${restrictions.definition.name} mode denies ${toolName}. Switch modes with ${THREAD_STATE_TOOL} first.`;
  }
}
