/*
 * Exports:
 * - createReloadableNodeModuleLoader: load the daemon root through the shared cache-subtree loader.
 */
import { createReloadableNodeModuleLoader as createSharedLoader } from "workbench-shared/reload/reloadable-node-loader";

export function createReloadableNodeModuleLoader<TContext, TObjects extends object, TNotification>() {
  return createSharedLoader<TContext, TObjects, TNotification>(require, "./daemon-root-node");
}
