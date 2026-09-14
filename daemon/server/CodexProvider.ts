/*
 * Exports:
 * - default CodexProvider: bind graph-owned Codex capabilities to the daemon provider contract.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [],
  create: (_context, { get }) => ({
    registrations: { codexProvider: { configuration: { modelContext: get("codexConfiguration") } } },
    start: () => undefined,
    dispose: () => undefined,
  }),
  description: "Reload the Codex provider definition.",
  lifecycle: "atomic",
  provides: ["codexProvider"],
  requires: ["codexConfiguration"],
  safeAll: true,
  scope: "server:codex/def",
  sources: "daemon/server/CodexProvider.ts",
});
