/*
 * Exports:
 * - WorkbenchThreadWorkflowPorts: where one thread's instruction selection, skills, pinned instructions and workflow ledger come from.
 * - WorkbenchThreadWorkflow: a thread's resolved overlays, ledger, current mode and process documents.
 * - default WorkbenchThreadWorkflowReader: own reading a thread's workflow state from the instructions it was given, and the edit and
 *   tool denials its lock state and current mode impose.
 */
import path from "node:path";
import { z } from "zod";
import { parseProcessDocumentRevision } from "workbench-shared/workbench/git/git-arc-storage";
import type { WorkbenchInstructionSelection } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import {
  describeCompactionEditDenial, describeModeEditDenial, describeModeToolDenial, PRE_MODE_DENIAL,
} from "workbench-shared/workbench/thread/workflow-denials";
import {
  awaitsFirstMode, compactionRecoveryNeeds, currentProcessDocuments, currentWorkflowMode, effectiveWorkflowMode, findWorkflowMode,
  PRE_MODE_TOOLS, THREAD_STATE_TOOL, type WorkflowLedgerEntry, type WorkflowMode,
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
  processDocuments: readonly string[];
  projectRoot: string | null;
}

type GateState = Pick<WorkbenchThreadWorkflow, "ledger" | "overlays" | "projectRoot">;

const GIT_ARC_EDIT_TOOL_PREFIX = "git_arc_edit_";
const GIT_ARC_RESTORE_TOOL = "git_arc_restore";
const GIT_ARC_WORKTREE_TOOLS: ReadonlySet<string> = new Set([GIT_ARC_RESTORE_TOOL, "git_arc_stash", "git_arc_unstash"]);
const RestoreInputSchema = z.object({ ref: z.string() }).passthrough();

function comparable(value: string) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function isWorktreeTool(toolName: string) {
  return toolName.startsWith(GIT_ARC_EDIT_TOOL_PREFIX) || GIT_ARC_WORKTREE_TOOLS.has(toolName);
}

function isProcessDocumentRestore(toolName: string, input: unknown) {
  if (toolName !== GIT_ARC_RESTORE_TOOL) return false;
  const parsed = RestoreInputSchema.safeParse(input);
  return parsed.success && parseProcessDocumentRevision(parsed.data.ref) !== null;
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
    return { overlays, ledger, mode, definition: findWorkflowMode(overlays.modes, mode), processDocuments: currentProcessDocuments(ledger), projectRoot };
  }

  async #state(threadId: string): Promise<GateState> {
    const [ledger, { overlays, projectRoot }] = await Promise.all([this.ports.readLedger(threadId), this.readOverlays(threadId)]);
    return { ledger, overlays, projectRoot };
  }

  /**
   * Locks outrank modes and process documents: before a first mode only PRE_MODE_TOOLS run, and an unrecovered compaction
   * denies every edit. `edit` tells the lock whether the call writes files.
   */
  #lockDenial({ ledger, overlays }: GateState, edit: boolean) {
    if (awaitsFirstMode(ledger, overlays.modes)) return PRE_MODE_DENIAL;
    const recovery = edit ? compactionRecoveryNeeds(ledger, overlays.checklists) : null;
    return recovery ? describeCompactionEditDenial(recovery) : null;
  }

  /**
   * `edit` denies every requested path, `edit:claims` only claimed Git-visible ones; process documents are exempt. Undeclared
   * modes follow the first declared mode's rules.
   */
  async readEditDenial(threadId: string, requested: readonly string[], claimed: readonly string[]) {
    if (!requested.length) return null;
    const state = await this.#state(threadId);
    const lock = this.#lockDenial(state, true);
    if (lock) return lock;
    const definition = effectiveWorkflowMode(state.ledger, state.overlays.modes);
    if (!definition?.deny.length) return null;
    const { projectRoot } = state;
    const scope = definition.deny.includes("edit") ? requested : definition.deny.includes("edit:claims") ? claimed : [];
    const exempt = new Set(currentProcessDocuments(state.ledger).map(entry => comparable(projectRoot ? path.resolve(projectRoot, entry) : entry)));
    const denied = scope.filter(candidate => !exempt.has(comparable(candidate)));
    if (!denied.length) return null;
    return describeModeEditDenial(definition.name, definition.deny.includes("edit") ? "file edits" : "edits to Git-visible files", denied);
  }

  /**
   * thread_state can never be denied, so a lock or denying mode can always be left. Edit denials and the compaction lock also
   * cover Git arc tools that write the worktree; `read` names native file-read tools. Process documents are editable in every
   * mode, so restoring one from its backups is too, though the locks still hold.
   */
  async readToolDenial(threadId: string, toolName: string, input?: unknown) {
    if (toolName === THREAD_STATE_TOOL) return null;
    const state = await this.#state(threadId);
    const worktreeTool = isWorktreeTool(toolName);
    if (awaitsFirstMode(state.ledger, state.overlays.modes)) return PRE_MODE_TOOLS.has(toolName) ? null : PRE_MODE_DENIAL;
    const lock = this.#lockDenial(state, worktreeTool);
    if (lock) return lock;
    const definition = effectiveWorkflowMode(state.ledger, state.overlays.modes);
    const deny = definition?.deny ?? [];
    const editTool = worktreeTool && !isProcessDocumentRestore(toolName, input) && deny.some(token => token === "edit" || token === "edit:claims");
    if (!definition || (!deny.includes(toolName) && !editTool)) return null;
    return describeModeToolDenial(definition.name, toolName);
  }
}
