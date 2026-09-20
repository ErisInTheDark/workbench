/*
 * Exports:
 * - OpenCodeManagedSessionContext: provider-local instruction refresh input.
 * - OpenCodeManagedSessionControllerOptions: injectable managed-session boundaries.
 * - default OpenCodeManagedSessionController: own OpenCode session marking, native mutation denial, and fresh instructions.
 */
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";
import {
  buildWorkbenchActivatedSkillCatalog,
  buildWorkbenchPromptInstructions,
  filterWorkbenchInstructionContent,
  listWorkbenchInstructionMechanics,
} from "../../lib/workbench/instructions/WorkbenchPromptFiles";
import { formatWorkbenchInstructionFilterWarning } from "../../lib/workbench/instructions/instruction-context-filter";

const NATIVE_MUTATION_ACTIONS = ["apply_patch", "bash", "edit", "patch", "shell", "write"] as const;

export interface OpenCodeManagedSessionContext {
  sessionID: string;
  cwd: string;
  projectId: string;
  threadId: string;
  model: string | null;
  agentPath: string | null;
  workflowIds: readonly string[];
  activatedSkillPaths: readonly string[];
}

interface BuiltInstructions {
  baseInstructions: string | null;
  developerInstructions: string | null;
  activatedSkills: string | null;
}

export interface OpenCodeManagedSessionControllerOptions {
  acquire: () => Promise<WorkbenchOpenCodeClient>;
  build?: (context: OpenCodeManagedSessionContext & { harness: "opencode" }) => Promise<BuiltInstructions>;
  workbenchOrigin?: string;
}

export default class OpenCodeManagedSessionController {
  constructor(private readonly options: OpenCodeManagedSessionControllerOptions) {}

  creation() {
    return {
      metadata: { workbench: { managed: true, provider: "opencode", version: 1 } },
      permissions: NATIVE_MUTATION_ACTIONS.map(action => ({
        action,
        resource: "*",
        effect: "deny" as const,
      })),
    };
  }

  async refresh(input: OpenCodeManagedSessionContext) {
    const context = { ...input, harness: "opencode" as const };
    const built = await (this.options.build ?? (value => this.build(value)))(context);
    const value = [
      built.baseInstructions,
      built.developerInstructions,
      built.activatedSkills,
    ].filter((part): part is string => Boolean(part?.trim())).join("\n\n");
    await (await this.options.acquire()).session.instructions.entry.put({
      sessionID: input.sessionID,
      key: "workbench",
      value,
    });
  }

  private async build(context: OpenCodeManagedSessionContext & { harness: "opencode" }): Promise<BuiltInstructions> {
    const promptContext = {
      agentPath: context.agentPath,
      activatedSkillPaths: context.activatedSkillPaths,
      cwd: context.cwd,
      harness: context.harness,
      managedThread: true,
      projectId: context.projectId,
      skillCatalogPresentation: "bodies" as const,
      threadId: context.threadId,
      workbenchOrigin: this.options.workbenchOrigin,
      workflowIds: context.workflowIds,
    };
    const [instructions, activatedSkills, available] = await Promise.all([
      buildWorkbenchPromptInstructions(promptContext),
      buildWorkbenchActivatedSkillCatalog(promptContext),
      listWorkbenchInstructionMechanics(promptContext),
    ]);
    const filter = (content: string | null, field: string) => filterWorkbenchInstructionContent(content, {
      available,
      field,
      harness: "opencode",
      model: context.model,
      onWarning: warning => process.stderr.write(`${formatWorkbenchInstructionFilterWarning(warning)}\n`),
      shell: process.platform === "win32" ? "pwsh" : "bash",
    });
    return {
      baseInstructions: filter(instructions.baseInstructions, "baseInstructions"),
      developerInstructions: filter(instructions.developerInstructions, "developerInstructions"),
      activatedSkills: filter(activatedSkills, "input.wb:activated-skills"),
    };
  }
}
