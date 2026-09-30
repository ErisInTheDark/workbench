/*
 * Exports:
 * - default ThreadProfileEditorController: own editor disclosures and fenced catalogue loading, not profile settings.
 * - ProfileEditorSection: mutually exclusive configuration sections.
 */
import type { WorkbenchAgentOption, WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";

export type ProfileEditorSection = "profile" | "model" | "agent";

export default class ThreadProfileEditorController {
  private readonly listeners = new Set<() => void>();
  private modelGeneration = 0;
  private readonly modelGenerations = new Map<WorkbenchHarness, number>();
  private agentGeneration = 0;
  private snapshot = {
    open: false,
    activeSection: null as ProfileEditorSection | null,
    modelsByHarness: {} as Partial<Record<WorkbenchHarness, WorkbenchModelOption[]>>,
    modelsLoadingByHarness: {} as Partial<Record<WorkbenchHarness, boolean>>,
    modelsErrorByHarness: {} as Partial<Record<WorkbenchHarness, string>>,
    agents: [] as WorkbenchAgentOption[],
    agentsLoading: false,
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
    this.modelGenerations.clear();
    this.agentGeneration++;
    this.publish({ open: false, activeSection: null, modelsByHarness: {}, modelsLoadingByHarness: {}, modelsErrorByHarness: {}, agents: [], agentsLoading: false, agentsError: "" });
  }
  resetModels() {
    this.modelGeneration++;
    this.modelGenerations.clear();
    this.publish({ modelsByHarness: {}, modelsLoadingByHarness: {}, modelsErrorByHarness: {} });
  }
  resetAgents() {
    this.agentGeneration++;
    this.publish({ agents: [], agentsLoading: false, agentsError: "" });
  }
  async loadModels(harness: WorkbenchHarness, load: () => Promise<WorkbenchModelOption[]>): Promise<WorkbenchModelOption[] | null> {
    const resetGeneration = this.modelGeneration;
    const generation = (this.modelGenerations.get(harness) ?? 0) + 1;
    this.modelGenerations.set(harness, generation);
    this.publish({
      modelsLoadingByHarness: { ...this.snapshot.modelsLoadingByHarness, [harness]: true },
      modelsErrorByHarness: { ...this.snapshot.modelsErrorByHarness, [harness]: "" },
    });
    try {
      const models = await load();
      if (resetGeneration !== this.modelGeneration || generation !== this.modelGenerations.get(harness)) return null;
      this.publish({
        modelsByHarness: { ...this.snapshot.modelsByHarness, [harness]: models },
        modelsLoadingByHarness: { ...this.snapshot.modelsLoadingByHarness, [harness]: false },
      });
      return models;
    } catch (error) {
      if (resetGeneration === this.modelGeneration && generation === this.modelGenerations.get(harness)) {
        const message = error instanceof Error ? error.message : "Unable to load models.";
        this.publish({
          modelsLoadingByHarness: { ...this.snapshot.modelsLoadingByHarness, [harness]: false },
          modelsErrorByHarness: { ...this.snapshot.modelsErrorByHarness, [harness]: message },
        });
      }
      return null;
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
