/*
 * Keywords: reload, graph, process, orchestrator.
 * Exports:
 * - ReloadableNodeModuleLoader: shared graph definition loader contract.
 * - ReloadableNodeHostOptions: orchestrator host configuration ports.
 * - default ReloadableNodeHost: orchestrator source and scope policy for the shared graph host.
 */
import SharedReloadableNodeHost, {
  type ReloadableNodeHostOptions as SharedReloadableNodeHostOptions,
  type ReloadableNodeModuleLoader,
} from "workbench-shared/reload/ReloadableNodeHost";

export type { ReloadableNodeModuleLoader };

export interface ReloadableNodeHostOptions extends Omit<
  SharedReloadableNodeHostOptions,
  "processScope" | "topologyScope"
> {}

const PROCESS_SOURCES = [
  "daemon/orchestrator/index.ts",
  "daemon/orchestrator/ReloadableNodeHost.ts",
  "daemon/orchestrator/reloadable-node-loader.ts",
  "daemon/orchestrator/orchestrator-process-context.ts",
  "daemon/orchestrator/WorkbenchOrchestratorControlIngress.ts",
  "shared/workbench/orchestrator-health.ts",
  "shared/workbench/orchestrator-reload.ts",
  "shared/reload/**",
  "shared/source-pattern-matcher.ts",
].join("\n");

export default class ReloadableNodeHost<TContext, TFeatures extends object, TNotification>
  extends SharedReloadableNodeHost<TContext, TFeatures, TNotification> {
  constructor(
    context: TContext,
    loader: ReloadableNodeModuleLoader<TContext, TFeatures, TNotification>,
    options: ReloadableNodeHostOptions = {},
  ) {
    super(context, loader, {
      ...options,
      processScope: {
        descriptor: {
          access: "operator",
          description: "Restart the complete orchestrator process to replace the stable graph kernel.",
          destructive: true,
          safeAll: false,
          scope: "server:process",
        },
        sources: PROCESS_SOURCES,
      },
      topologyScope: "server:topology",
    });
  }
}
