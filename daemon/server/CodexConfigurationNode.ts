/*
 * Exports:
 * - default CodexConfigurationNode: own local Codex configuration independently of harness readiness.
 */
import CodexModelCatalog from "./CodexModelCatalog";
import CodexProvider from "./CodexProvider";
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [CodexProvider],
  create: () => ({
    registrations: { codexConfiguration: new CodexModelCatalog() },
    start: () => undefined,
    dispose: () => undefined,
  }),
  description: "Reload local Codex configuration and its provider definition.",
  lifecycle: "atomic",
  provides: ["codexConfiguration"],
  requires: [],
  safeAll: true,
  scope: "server:codex/configuration",
  sources: [
    "daemon/server/CodexConfigurationNode.ts",
    "daemon/server/CodexModelCatalog.ts",
    "daemon/server/lib/codex/codex-home.ts",
  ].join("\n"),
});
