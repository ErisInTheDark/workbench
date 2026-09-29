/*
 * Exports:
 * - default WorkbenchSkillController: load and render one precedence-selected skill for a managed caller.
 */
import type { WorkbenchSkillDefinition, WorkbenchHarness, WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import type { WorkbenchInstructionTool } from "./lib/workbench/instructions/instruction-tool-reference";
import path from "node:path";
import { stripWorkbenchInstructionFrontmatter } from "./lib/workbench-library";
import { createManagedThreadFilter } from "./lib/workbench/instructions/workbench-managed-thread-instructions";
import { renderWorkbenchSkillContent } from "./lib/workbench/instructions/skill-rendering";

interface WorkbenchSkillControllerOptions {
  listSkills: (projectRoot: string) => Promise<readonly WorkbenchSkillDefinition[]>;
  readInstructionTools: () => Promise<readonly WorkbenchInstructionTool[]>;
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>;
}

interface WorkbenchSkillRequest {
  cwd: string;
  harness: WorkbenchHarness;
  model: string;
  name: string;
  threadId: string;
}

export default class WorkbenchSkillController {
  constructor(private readonly options: WorkbenchSkillControllerOptions) {}

  async execute(request: WorkbenchSkillRequest, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const skills = await this.options.listSkills(request.cwd);
    const skill = skills.find(candidate => (
      path.basename(path.dirname(candidate.relativePath)).toLocaleLowerCase() === request.name.toLocaleLowerCase()
    ));
    if (!skill) return new Response("Workbench skill was not found.\n", { status: 404 });
    if (!request.model.trim()) return new Response("The managed thread has no model for instruction filtering.\n", { status: 409 });

    try {
      const body = stripWorkbenchInstructionFrontmatter(renderWorkbenchSkillContent(skill));
      const filter = await createManagedThreadFilter({
        cwd: request.cwd,
        harness: request.harness,
        managedThread: true,
        model: request.model,
        readInstructionTools: this.options.readInstructionTools,
        roots: [{ id: "project", isPrimary: true, name: "project", relativePath: ".", rootPath: request.cwd }],
        threadId: request.threadId,
      }, this.options.readLocalCapabilities);
      signal.throwIfAborted();
      return new Response(filter(body, skill.path)?.trim() ?? "", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const detail = error instanceof Error ? error.message : "unknown error";
      console.warn(`[workbench-skill] Failed to render skill: ${detail.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300)}`);
      return new Response("Workbench skill could not be rendered.\n", { status: 500 });
    }
  }
}
