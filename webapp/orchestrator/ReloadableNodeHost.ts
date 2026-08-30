/*
 * Exports:
 * - ReloadableNodeHostOptions/default ReloadableNodeHost: orchestrator policy adapter over the shared graph host.
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
  "webapp/orchestrator/index.ts",
  "webapp/orchestrator/ReloadableNodeHost.ts",
  "webapp/orchestrator/reloadable-node-loader.ts",
  "webapp/orchestrator/orchestrator-process-context.ts",
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
