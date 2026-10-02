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
        // The process module's import walk owns every process source.
        assets: "",
      },
      topologyScope: "server:topology",
    });
  }
}
