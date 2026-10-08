/*
 * Exports:
 * - WORKBENCH_CORE_FEATURE_KEYS: feature keys owned by the core lifecycle node.
 * - default WorkbenchCoreFeature: core node value and lifecycle owner for state, Git, thread skills, questionnaire waits, live approvals, harness routing, and supervisors.
 */
import type { ReloadableNodeInstance } from "./ReloadableNode";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

export const WORKBENCH_CORE_FEATURE_KEYS = [
  "agentContext",
  "approvals",
  "voiceSettings",
  "browseSessionCleanup",
  "daemonRequests",
  "gitArc",
  "harnesses",
  "messages",
  "modules",
  "projectCatalog",
  "projectSnapshot",
  "projectStore",
  "providerObservations",
  "questionnaires",
  "subagents",
  "subagentQueues",
  "stats",
  "threadGit",
  "threadState",
  "threadActions",
  "threadContextRollover",
  "threadSkills",
  "transcriptReader",
  "transcriptReconciliation",
  "turnRecoveryFailures",
  "workingTree",
  "accountLimits",
  "threadRuntime",
] as const satisfies readonly (keyof DaemonRuntimeObjects)[];

interface WorkbenchCoreFeatureOptions {
  hasPendingWork?(): boolean;
  afterCommit?(): void;
  beginRuntimeDrain(): void;
  captureReloadState?(): unknown;
  dispose(reportPhase: (phase: string) => void): Promise<void> | void;
  registrations: Pick<DaemonRuntimeObjects, typeof WORKBENCH_CORE_FEATURE_KEYS[number]>;
  start(reportPhase: (phase: string) => void): Promise<void> | void;
}

export default class WorkbenchCoreFeature implements ReloadableNodeInstance<DaemonRuntimeObjects, DaemonProviderNotification> {
  readonly registrations: Partial<DaemonRuntimeObjects>;

  constructor(private readonly options: WorkbenchCoreFeatureOptions) {
    this.registrations = options.registrations;
  }

  hasPendingWork() { return this.options.hasPendingWork?.() ?? false; }

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

  async start(reportPhase: (phase: string) => void = () => undefined) {
    await this.options.start(reportPhase);
  }
}
