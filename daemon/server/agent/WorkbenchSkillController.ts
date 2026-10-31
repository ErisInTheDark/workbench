/*
 * Exports:
 * - default WorkbenchSkillController: load and render one precedence-selected skill for a managed caller, reporting the load, or list every copy's source path.
 */
import type { WorkbenchSkillDefinition, WorkbenchHarness, WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import type { WorkbenchInstructionTool } from "../lib/workbench/instructions/instruction-tool-reference";
import path from "node:path";
import { stripWorkbenchInstructionFrontmatter, type WorkbenchSkillLocation } from "../lib/workbench-library";
import { createManagedThreadFilter } from "../lib/workbench/instructions/workbench-managed-thread-instructions";
import { renderWorkbenchSkillContent } from "../lib/workbench/instructions/skill-rendering";
import { formatSkillComponentHints } from "../lib/workbench/skills/skill-components";

const STATE_WIDTH = "shadowed  ".length;
const SOURCE_WIDTH = "local overlay  ".length;

function plainText(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

interface WorkbenchSkillControllerOptions {
  listSkills: (projectRoot: string) => Promise<readonly WorkbenchSkillDefinition[]>;
  locateSkill: (projectRoot: string, name: string) => Promise<WorkbenchSkillLocation>;
  readInstructionTools: () => Promise<readonly WorkbenchInstructionTool[]>;
  readLocalCapabilities: () => Promise<WorkbenchLocalCapabilitySettings>;
  /** Observe a successful Skill Load; failure never withholds the loaded body. */
  onLoaded?: (input: { threadId: string; path: string }) => Promise<void>;
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
    return await this.render(request, signal, true);
  }

  async locate(request: Pick<WorkbenchSkillRequest, "cwd" | "name">, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const location = await this.options.locateSkill(request.cwd, request.name);
    signal.throwIfAborted();
    const copies = location.layers.flatMap(layer => layer.path ? [{ source: layer.source, path: layer.path }] : []);
    if (!copies.length && !location.hidden) {
      const searched = location.layers.map(layer => `${layer.source.padEnd(SOURCE_WIDTH)}${layer.directory}`);
      return plainText(`${["Workbench skill was not found. Searched in precedence order:", ...searched].join("\n")}\n`, 404);
    }
    const lines = copies.map((copy, index) => {
      const state = location.hidden ? "hidden" : index === 0 ? "active" : "shadowed";
      return `${state.padEnd(STATE_WIDTH)}${copy.source.padEnd(SOURCE_WIDTH)}${copy.path}`;
    });
    if (location.hidden) lines.unshift("A .agents.local/skills tombstone hides this skill from the project.");
    return plainText(`${lines.join("\n")}\n`);
  }

  async render(request: WorkbenchSkillRequest, signal: AbortSignal, recordLoad = false): Promise<Response> {
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
      const rendered = `${filter(body, skill.path)?.trim() ?? ""}${formatSkillComponentHints(skill.content)}`.trim();
      if (recordLoad) {
        await this.options.onLoaded?.({ threadId: request.threadId, path: skill.path }).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : "unknown error";
          console.warn(`[workbench-skill] Skill load was not recorded: ${detail.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300)}`);
        });
      }
      return plainText(rendered);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const detail = error instanceof Error ? error.message : "unknown error";
      console.warn(`[workbench-skill] Failed to render skill: ${detail.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300)}`);
      return new Response("Workbench skill could not be rendered.\n", { status: 500 });
    }
  }
}
