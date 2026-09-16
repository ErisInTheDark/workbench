/*
 * Exports:
 * - default CodexConfigurationNode: own local Codex configuration independently of harness readiness.
 */
import CodexModelCatalog from "./CodexModelCatalog";
import { readCodexGlobalGuidance, containsExactGuidanceText } from "./lib/codex/CodexGlobalGuidance";
import CodexProvider from "./CodexProvider";
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [CodexProvider],
  create: () => {
    const catalog = new CodexModelCatalog();
    return {
      registrations: { codexConfiguration: {
        read: () => catalog.read(),
        containsGlobalGuidance: async (sections: string[]) => {
          const guidance = await readCodexGlobalGuidance();
          return sections.map(section => containsExactGuidanceText(guidance, section));
        },
      } },
      start: () => undefined,
      dispose: () => undefined,
    };
  },
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
    "daemon/server/lib/codex/CodexGlobalGuidance.ts",
  ].join("\n"),
});
