/*
 * Exports:
 * - default WorkbenchAgentSkillCatalogController: own browser-visible agent and skill catalog reads, and the activatable skills messages are checked against.
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
    const [projectSkills, instructionPacks] = await Promise.all([
      this.readProjectSkills(projectId),
      this.operations.listInstructionPacks(),
    ]);
    const [activeSkills, globallyIncluded] = await Promise.all([
      this.activeSkillSummaries(projectSkills),
      this.containsGlobalGuidance(provider, instructionPacks.map(pack => pack.content)),
    ]);
    const globallyPresent = instructionPacks
      .filter((_pack, index) => globallyIncluded[index])
      .map((pack) => pack.content);
    return {
      data: activeSkills,
      instructionPacks,
      instructions: await this.operations.buildBootstrap(projectSkills, { skipInstructionPackContents: globallyPresent }) ?? "",
    };
  }

  /** The skills a message in this project can activate: the same list `readSkills` gives the composer. */
  async readActivatableSkills(projectId: string) {
    return await this.activeSkillSummaries(await this.readProjectSkills(projectId));
  }

  private async readProjectSkills(projectId: string | null) {
    const project = projectId ? await this.resolveProjectById(projectId) : null;
    return project && project.kind !== "workbench-library" ? await this.operations.listProjectSkills(project.root) : [];
  }

  private async activeSkillSummaries(projectSkills: Awaited<ReturnType<typeof listProjectSkillDefinitionsFromRoot>>) {
    return (await this.operations.listActiveSkills(projectSkills))
      .map(({ description, name, path, relativePath }) => ({ description, name, path, relativePath }));
  }
}
