/*
 * Exports:
 * - default WorkbenchAgentSkillCatalogController: own browser-visible agent and skill catalog reads. Keywords: agent, skill, catalog, instructions.
 */
import { containsExactGuidanceText, readCodexGlobalGuidance } from "../lib/codex/CodexGlobalGuidance";
import {
  listProjectSkillDefinitionsFromRoot,
  listUserInvocableAgentsFromResolvedProject,
  readUserInvocableAgentDefinitionFromRoot,
  type ResolvedProject,
} from "../lib/project";
import {
  buildWorkbenchLibraryBootstrapInstructions,
  listActiveWorkbenchSkillDefinitions,
  listWorkbenchLibraryInstructions,
} from "../lib/workbench-library";

interface WorkbenchAgentSkillCatalogOperations {
  buildBootstrap: typeof buildWorkbenchLibraryBootstrapInstructions;
  containsExactGuidanceText: typeof containsExactGuidanceText;
  listActiveSkills: typeof listActiveWorkbenchSkillDefinitions;
  listInstructionPacks: typeof listWorkbenchLibraryInstructions;
  listProjectSkills: typeof listProjectSkillDefinitionsFromRoot;
  listUserAgents: typeof listUserInvocableAgentsFromResolvedProject;
  readAgent: typeof readUserInvocableAgentDefinitionFromRoot;
  readGlobalGuidance: typeof readCodexGlobalGuidance;
}

const defaultOperations: WorkbenchAgentSkillCatalogOperations = {
  buildBootstrap: buildWorkbenchLibraryBootstrapInstructions,
  containsExactGuidanceText,
  listActiveSkills: listActiveWorkbenchSkillDefinitions,
  listInstructionPacks: listWorkbenchLibraryInstructions,
  listProjectSkills: listProjectSkillDefinitionsFromRoot,
  listUserAgents: listUserInvocableAgentsFromResolvedProject,
  readAgent: readUserInvocableAgentDefinitionFromRoot,
  readGlobalGuidance: readCodexGlobalGuidance,
};

export default class WorkbenchAgentSkillCatalogController {
  constructor(
    private readonly resolveProjectById: (projectId: string) => Promise<ResolvedProject>,
    private readonly operations = defaultOperations,
  ) {}

  async listAgents(projectId: string) {
    const project = await this.resolveProjectById(projectId);
    return { data: await this.operations.listUserAgents(project) };
  }

  async readAgent(projectId: string, agentPath: string) {
    const readAgent = agentPath.startsWith("library:")
      ? this.operations.readAgent(agentPath, "")
      : this.resolveProjectById(projectId).then((project) => this.operations.readAgent(agentPath, project.root));
    const [data, globalGuidance] = await Promise.all([
      readAgent,
      this.operations.readGlobalGuidance(),
    ]);
    return { codexGlobalDuplicate: this.operations.containsExactGuidanceText(globalGuidance, data.prompt), data };
  }

  async readSkills(projectId: string | null) {
    const project = projectId ? await this.resolveProjectById(projectId) : null;
    const [projectSkills, instructionPacks] = await Promise.all([
      project && project.kind !== "workbench-library" ? this.operations.listProjectSkills(project.root) : Promise.resolve([]),
      this.operations.listInstructionPacks(),
    ]);
    const [activeSkills, globalGuidance] = await Promise.all([
      this.operations.listActiveSkills(projectSkills),
      this.operations.readGlobalGuidance(),
    ]);
    const globallyPresent = instructionPacks
      .filter((pack) => this.operations.containsExactGuidanceText(globalGuidance, pack.content))
      .map((pack) => pack.content);
    return {
      data: activeSkills.map(({ description, name, path, relativePath }) => ({ description, name, path, relativePath })),
      instructionPacks,
      instructions: await this.operations.buildBootstrap(projectSkills, { skipInstructionPackContents: globallyPresent }) ?? "",
    };
  }
}
