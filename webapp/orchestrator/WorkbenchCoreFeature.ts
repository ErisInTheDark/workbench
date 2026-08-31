/*
 * Exports:
 * - WORKBENCH_CORE_FEATURE_KEYS: feature keys owned by the core lifecycle node. Keywords: core, ownership, graph.
 * - default WorkbenchCoreFeature: core node value and lifecycle owner for state, Git, harness routing, and supervisors. Keywords: core, lifecycle, disposal.
 */
import type { ReloadableNodeInstance } from "./ReloadableNode";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";

export const WORKBENCH_CORE_FEATURE_KEYS = [
  "bridgeRequest",
  "browseSessionCleanup",
  "codexHealth",
  "daemonRequests",
  "gitArc",
  "harnesses",
  "legacyMigrationSource",
  "modules",
  "projectCatalog",
  "projectSnapshot",
  "subagents",
  "threadGit",
  "threadState",
] as const satisfies readonly (keyof OrchestratorRuntimeObjects)[];

interface WorkbenchCoreFeatureOptions {
  beginRuntimeDrain(): void;
  dispose(reportPhase: (phase: string) => void): Promise<void> | void;
  registrations: Pick<OrchestratorRuntimeObjects, typeof WORKBENCH_CORE_FEATURE_KEYS[number]>;
  observeProviderNotification(notification: OrchestratorProviderNotification): Promise<void> | void;
  start(): Promise<void> | void;
}

export default class WorkbenchCoreFeature implements ReloadableNodeInstance<OrchestratorRuntimeObjects, OrchestratorProviderNotification> {
  readonly registrations: Partial<OrchestratorRuntimeObjects>;

  constructor(private readonly options: WorkbenchCoreFeatureOptions) {
    this.registrations = options.registrations;
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
