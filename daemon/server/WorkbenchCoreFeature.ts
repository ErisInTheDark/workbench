/*
 * Exports:
 * - WORKBENCH_CORE_FEATURE_KEYS: feature keys owned by the core lifecycle node.
 * - default WorkbenchCoreFeature: core node value and lifecycle owner for state, Git, questionnaire waits, harness routing, and supervisors.
 */
import type { ReloadableNodeInstance } from "./ReloadableNode";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

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
  "questionnaires",
  "subagents",
  "stats",
  "threadGit",
  "threadState",
] as const satisfies readonly (keyof DaemonRuntimeObjects)[];

interface WorkbenchCoreFeatureOptions {
  afterCommit?(): void;
  beginRuntimeDrain(): void;
  captureReloadState?(): unknown;
  dispose(reportPhase: (phase: string) => void): Promise<void> | void;
  registrations: Pick<DaemonRuntimeObjects, typeof WORKBENCH_CORE_FEATURE_KEYS[number]>;
  observeProviderNotification(notification: DaemonProviderNotification): Promise<void> | void;
  start(reportPhase: (phase: string) => void): Promise<void> | void;
}

export default class WorkbenchCoreFeature implements ReloadableNodeInstance<DaemonRuntimeObjects, DaemonProviderNotification> {
  readonly registrations: Partial<DaemonRuntimeObjects>;

  constructor(private readonly options: WorkbenchCoreFeatureOptions) {
    this.registrations = options.registrations;
  }

  beginRuntimeDrain() {
    this.options.beginRuntimeDrain();
  }

  captureReloadState() {
    return this.options.captureReloadState?.();
  }

  afterCommit() {
    this.options.afterCommit?.();
  }

  async dispose(reportPhase: (phase: string) => void = () => undefined) {
    await this.options.dispose(reportPhase);
  }

  async observeProviderNotification(notification: DaemonProviderNotification) {
    await this.options.observeProviderNotification(notification);
  }

  async start(reportPhase: (phase: string) => void = () => undefined) {
    await this.options.start(reportPhase);
  }
}
