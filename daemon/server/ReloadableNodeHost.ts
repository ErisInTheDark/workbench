/*
 * Exports:
 * - ReloadableNodeModuleLoader: shared graph definition loader contract.
 * - ReloadableNodeHostOptions: daemon host configuration ports.
 * - default ReloadableNodeHost: daemon source and scope policy for the shared graph host.
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
  "daemon/server/index.ts",
  "daemon/server/ReloadableNodeHost.ts",
  "daemon/server/reloadable-node-loader.ts",
  "daemon/server/daemon-process-context.ts",
  "daemon/server/WorkbenchDaemonControlIngress.ts",
  "shared/workbench/daemon-health.ts",
  "shared/workbench/daemon-reload.ts",
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
          description: "Restart the complete daemon process to replace the stable graph kernel.",
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
