/*
 * Exports:
 * - default ThreadProfileEditorController: own editor disclosures and fenced catalogue loading, not profile settings.
 * - ProfileEditorSection: mutually exclusive configuration sections.
 */
import type { WorkbenchAgentOption, WorkbenchModelOption } from "workbench-shared/types";

export type ProfileEditorSection = "profile" | "harness" | "model" | "agent";

export default class ThreadProfileEditorController {
  private readonly listeners = new Set<() => void>();
  private modelGeneration = 0;
  private agentGeneration = 0;
  private snapshot = {
    open: false,
    activeSection: null as ProfileEditorSection | null,
    models: [] as WorkbenchModelOption[],
    agents: [] as WorkbenchAgentOption[],
    modelsLoading: false,
    agentsLoading: false,
    modelsError: "",
    agentsError: "",
  };

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish(update: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }
  open(section: ProfileEditorSection) { this.publish({ open: true, activeSection: section }); }
  toggle(section: ProfileEditorSection) {
    if (this.snapshot.open && this.snapshot.activeSection === section) this.close();
    else this.open(section);
  }
  close = () => { this.publish({ open: false, activeSection: null }); };
  disclose(section: ProfileEditorSection, open: boolean) {
    if (open) {
      if (this.snapshot.activeSection !== section) this.publish({ activeSection: section });
    } else if (this.snapshot.activeSection === section) {
      this.publish({ activeSection: null });
    }
  }
  reset() {
    this.modelGeneration++;
    this.agentGeneration++;
    this.publish({ open: false, activeSection: null, models: [], agents: [], modelsLoading: false, agentsLoading: false, modelsError: "", agentsError: "" });
  }
  resetModels() {
    this.modelGeneration++;
    this.publish({ models: [], modelsLoading: false, modelsError: "" });
  }
  resetAgents() {
    this.agentGeneration++;
    this.publish({ agents: [], agentsLoading: false, agentsError: "" });
  }
  async loadModels(load: () => Promise<WorkbenchModelOption[]>) {
    const generation = ++this.modelGeneration;
    this.publish({ modelsLoading: true, modelsError: "" });
    try {
      const models = await load();
      if (generation === this.modelGeneration) this.publish({ models, modelsLoading: false });
    } catch (error) {
      if (generation === this.modelGeneration) this.publish({ modelsLoading: false, modelsError: error instanceof Error ? error.message : "Unable to load models." });
    }
  }
  async loadAgents(load: () => Promise<WorkbenchAgentOption[]>) {
    const generation = ++this.agentGeneration;
    this.publish({ agentsLoading: true, agentsError: "" });
    try {
      const agents = await load();
      if (generation === this.agentGeneration) this.publish({ agents, agentsLoading: false });
    } catch (error) {
      if (generation === this.agentGeneration) this.publish({ agentsLoading: false, agentsError: error instanceof Error ? error.message : "Unable to load agents." });
    }
  }
}
