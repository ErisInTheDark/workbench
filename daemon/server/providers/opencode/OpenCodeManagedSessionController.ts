/*
 * Exports:
 * - OpenCodeManagedSessionContext: provider-local instruction refresh input.
 * - OpenCodeManagedSessionControllerOptions: injectable managed-session boundaries.
 * - default OpenCodeManagedSessionController: own OpenCode session marking, native command denial, and fresh instructions.
 */
import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";
import {
  buildWorkbenchManagedThreadActivatedSkills,
  buildWorkbenchManagedThreadInstructions,
} from "../../lib/workbench/instructions/WorkbenchPromptFiles";

const NATIVE_COMMAND_ACTIONS = ["bash", "shell"] as const;

function managedPermissions() {
  return NATIVE_COMMAND_ACTIONS.map(action => ({
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
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>;
  workbenchOrigin?: string;
}

export default class OpenCodeManagedSessionController {
  constructor(private readonly options: OpenCodeManagedSessionControllerOptions) {}

  creation() {
    return {
      metadata: { workbench: { managed: true, provider: "opencode", version: 1 } },
      permissions: managedPermissions(),
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
    const session = (await this.options.acquire()).session;
    await session.update({
      sessionID: input.sessionID,
      permissions: managedPermissions(),
    });
    await session.instructions.entry.put({
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
      model: context.model,
      projectId: context.projectId,
      threadId: context.threadId,
      workbenchOrigin: this.options.workbenchOrigin,
      workflowIds: context.workflowIds,
    };
    const [instructions, activatedSkills] = await Promise.all([
      buildWorkbenchManagedThreadInstructions(promptContext, this.options.readLocalCapabilities),
      buildWorkbenchManagedThreadActivatedSkills(promptContext, this.options.readLocalCapabilities),
    ]);
    return {
      baseInstructions: instructions.baseInstructions,
      developerInstructions: instructions.developerInstructions,
      activatedSkills,
    };
  }
}
