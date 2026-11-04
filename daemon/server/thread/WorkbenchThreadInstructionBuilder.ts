/*
 * Exports:
 * - WorkbenchThreadInstructionRequest: what a provider knows about one launch; the builder supplies roots, origin and tools.
 * - WorkbenchThreadInstructionBuilderPorts: project roots, tool catalogue, capabilities, local origin and the thread's pins.
 * - default WorkbenchThreadInstructionBuilder: own building a managed thread's instructions (with its frozen skill list) and activated
 *   skill bodies, pinning what each build delivers, and rebuilding a stored prefix's hash.
 */
import type { WorkbenchLocalCapabilitySettings, WorkbenchProjectRoot } from "workbench-shared/types";
import type { WorkbenchHarness } from "workbench-shared/types";
import * as workbenchPromptFiles from "../lib/workbench/instructions/WorkbenchPromptFiles";
import type { WorkbenchInstructionPrefixContext } from "../lib/workbench/instructions/WorkbenchPromptFiles";
import type { WorkbenchInstructionTool } from "../lib/workbench/instructions/instruction-tool-reference";
import type WorkbenchThreadInstructionPins from "./WorkbenchThreadInstructionPins";

export interface WorkbenchThreadInstructionRequest {
  harness: WorkbenchHarness;
  model: string | null;
  /** Null before the provider assigned the thread an id; such builds are not pinned. */
  threadId: string | null;
  projectId?: string | null;
  cwd?: string | null;
  agentPath?: string | null;
  subagentName?: string | null;
  workflowIds?: readonly string[];
  role?: "agent" | "voice-to-text";
  instructionScope?: "full" | "threadUtilities";
  instructionInjections?: Readonly<Record<string, string>>;
  /** A sender's own daemon origin, such as a remote parent's; defaults to this daemon's. */
  workbenchOrigin?: string | null;
  /** Roots the caller already resolved; otherwise read from the project. */
  roots?: readonly WorkbenchProjectRoot[];
}

export interface WorkbenchThreadInstructionBuilderPorts {
  readRoots(projectId: string): Promise<readonly WorkbenchProjectRoot[]>;
  readInstructionTools(): Promise<readonly WorkbenchInstructionTool[]>;
  readLocalCapabilities(): Promise<WorkbenchLocalCapabilitySettings>;
  workbenchOrigin: string;
  pins: Pick<WorkbenchThreadInstructionPins, "pin" | "readSkills">;
}

export default class WorkbenchThreadInstructionBuilder {
  constructor(private readonly ports: WorkbenchThreadInstructionBuilderPorts) {}

  /**
   * Base and developer instructions for one launch, pinned as the thread's delivered prefix. A thread's skill list stays as its prefix
   * froze it, so skill edits never rewrite the cached prefix; only a thread's first build, or one after compaction, lists current skills.
   */
  async build(request: WorkbenchThreadInstructionRequest) {
    const context = await this.#context(request);
    const pinned = request.threadId ? await this.ports.pins.readSkills(request.threadId) : null;
    const skills = pinned && !pinned.refreeze ? pinned.frozen : await workbenchPromptFiles.listWorkbenchPromptSkills(context);
    const built = await workbenchPromptFiles.buildWorkbenchManagedThreadInstructions(
      { ...context, skills }, () => this.ports.readLocalCapabilities(),
    );
    if (request.threadId) await this.ports.pins.pin(request.threadId, { base: built.overlayLayers, prefix: built.prefix });
    return { baseInstructions: built.baseInstructions, developerInstructions: built.developerInstructions };
  }

  /** Filtered bodies of the given skills, pinned as the thread's skill layers; null when none still resolve. */
  async skills(request: WorkbenchThreadInstructionRequest, paths: readonly string[]) {
    const built = await workbenchPromptFiles.buildWorkbenchManagedThreadActivatedSkills(
      { ...await this.#context(request), activatedSkillPaths: paths }, () => this.ports.readLocalCapabilities(),
    );
    if (request.threadId) await this.ports.pins.pin(request.threadId, { skills: built.skillLayers });
    return built.catalog;
  }

  /** The hash a build from a stored input would deliver now; the stored input is rebuilt exactly, never re-resolved. */
  async prefixHash(context: WorkbenchInstructionPrefixContext) {
    const { prefix } = await workbenchPromptFiles.buildWorkbenchManagedThreadInstructions(
      { ...context, readInstructionTools: () => this.ports.readInstructionTools() }, () => this.ports.readLocalCapabilities(),
    );
    if (!prefix) throw new Error("The rebuilt prefix has no storable input.");
    return prefix.hash;
  }

  async #context(request: WorkbenchThreadInstructionRequest) {
    return {
      ...request,
      managedThread: true,
      roots: request.roots ?? (request.projectId ? await this.ports.readRoots(request.projectId) : undefined),
      workbenchOrigin: request.workbenchOrigin ?? this.ports.workbenchOrigin,
      readInstructionTools: () => this.ports.readInstructionTools(),
    };
  }
}
