/*
 * Exports:
 * - WORKBENCH_CORE_FEATURE_KEYS: feature keys owned by the core lifecycle node. Keywords: core, ownership, graph.
 * - WORKBENCH_CORE_FEATURE_NODE_ID: stable graph id for the core lifecycle node. Keywords: core, node, id.
 * - default WorkbenchCoreFeature: core node value and lifecycle owner for state, Git, harness routing, and supervisors. Keywords: core, lifecycle, disposal.
 */
import type { OrchestratorFeatureNodeInstance } from "./OrchestratorFeatureHost";
import type { OrchestratorFeatures, OrchestratorProviderNotification } from "./orchestrator-feature-registry";

export const WORKBENCH_CORE_FEATURE_KEYS = [
  "agentCommand",
  "bridgeRequest",
  "browseSessionCleanup",
  "codexHealth",
  "gitArc",
  "harnesses",
  "legacyMigrationSource",
  "modules",
  "nextDevHealth",
  "projectCatalog",
  "projectSnapshot",
  "subagents",
  "threadGit",
  "threadState",
] as const satisfies readonly (keyof OrchestratorFeatures)[];

export const WORKBENCH_CORE_FEATURE_NODE_ID = "workbench-core";

interface WorkbenchCoreFeatureOptions {
  beginRuntimeDrain(): void;
  dispose(reportPhase: (phase: string) => void): Promise<void> | void;
  features: Pick<OrchestratorFeatures, typeof WORKBENCH_CORE_FEATURE_KEYS[number]>;
  observeProviderNotification(notification: OrchestratorProviderNotification): Promise<void> | void;
  start(): Promise<void> | void;
}

export default class WorkbenchCoreFeature implements OrchestratorFeatureNodeInstance<OrchestratorFeatures, OrchestratorProviderNotification> {
  readonly features: Partial<OrchestratorFeatures>;

  constructor(private readonly options: WorkbenchCoreFeatureOptions) {
    this.features = options.features;
  }

  beginRuntimeDrain() {
    this.options.beginRuntimeDrain();
  }

  async dispose(reportPhase: (phase: string) => void = () => undefined) {
    await this.options.dispose(reportPhase);
  }

  async observeProviderNotification(notification: OrchestratorProviderNotification) {
    await this.options.observeProviderNotification(notification);
  }

  async start() {
    await this.options.start();
  }
}
