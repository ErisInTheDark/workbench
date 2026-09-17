/*
 * Exports:
 * - default WorkbenchAgentSkillCatalogController: own browser-visible agent and skill catalog reads.
 */
import {
  listProjectSkillDefinitionsFromRoot,
  listUserInvocableAgentsFromResolvedProject,
  readUserInvocableAgentDefinitionFromRoot,
  type ResolvedProject,
} from "./lib/project";
import {
  buildWorkbenchLibraryBootstrapInstructions,
  listActiveWorkbenchSkillDefinitions,
  listWorkbenchLibraryInstructions,
} from "./lib/workbench-library";

interface WorkbenchAgentSkillCatalogOperations {
  buildBootstrap: typeof buildWorkbenchLibraryBootstrapInstructions;
  listActiveSkills: typeof listActiveWorkbenchSkillDefinitions;
  listInstructionPacks: typeof listWorkbenchLibraryInstructions;
  listProjectSkills: typeof listProjectSkillDefinitionsFromRoot;
  listUserAgents: typeof listUserInvocableAgentsFromResolvedProject;
  readAgent: typeof readUserInvocableAgentDefinitionFromRoot;
}

const defaultOperations: WorkbenchAgentSkillCatalogOperations = {
  buildBootstrap: buildWorkbenchLibraryBootstrapInstructions,
  listActiveSkills: listActiveWorkbenchSkillDefinitions,
  listInstructionPacks: listWorkbenchLibraryInstructions,
  listProjectSkills: listProjectSkillDefinitionsFromRoot,
  listUserAgents: listUserInvocableAgentsFromResolvedProject,
  readAgent: readUserInvocableAgentDefinitionFromRoot,
};

export default class WorkbenchAgentSkillCatalogController {
  constructor(
    private readonly resolveProjectById: (projectId: string) => Promise<ResolvedProject>,
    private readonly containsGlobalGuidance: (provider: string, sections: string[]) => Promise<boolean[]>,
    private readonly operations = defaultOperations,
  ) {}

  async listAgents(projectId: string) {
    const project = await this.resolveProjectById(projectId);
    return { data: await this.operations.listUserAgents(project) };
  }

  async readAgent(projectId: string, agentPath: string, provider: string) {
    const readAgent = agentPath.startsWith("library:")
      ? this.operations.readAgent(agentPath, "")
      : this.resolveProjectById(projectId).then((project) => this.operations.readAgent(agentPath, project.root));
    const data = await readAgent;
    const [providerGlobalDuplicate] = await this.containsGlobalGuidance(provider, [data.prompt]);
    return { providerGlobalDuplicate: providerGlobalDuplicate ?? false, data };
  }

  async readSkills(projectId: string | null, provider: string) {
    const project = projectId ? await this.resolveProjectById(projectId) : null;
    const [projectSkills, instructionPacks] = await Promise.all([
      project && project.kind !== "workbench-library" ? this.operations.listProjectSkills(project.root) : Promise.resolve([]),
      this.operations.listInstructionPacks(),
    ]);
    const [activeSkills, globallyIncluded] = await Promise.all([
      this.operations.listActiveSkills(projectSkills),
      this.containsGlobalGuidance(provider, instructionPacks.map(pack => pack.content)),
    ]);
    const globallyPresent = instructionPacks
      .filter((_pack, index) => globallyIncluded[index])
      .map((pack) => pack.content);
    return {
      data: activeSkills.map(({ description, name, path, relativePath }) => ({ description, name, path, relativePath })),
      instructionPacks,
      instructions: await this.operations.buildBootstrap(projectSkills, { skipInstructionPackContents: globallyPresent }) ?? "",
    };
  }
}
