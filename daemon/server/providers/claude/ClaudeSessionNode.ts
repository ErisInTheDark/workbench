/*
 * Exports:
 * - default ClaudeSessionNode: own live Claude Code processes so only an explicit harness reload interrupts Claude turns.
 */
import path from "node:path";
import ReloadableNode from "../../ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import ClaudeBridgeNode from "./ClaudeBridgeNode";
import ClaudeConfigView from "./ClaudeConfigView";
import ClaudeSessionHost from "./ClaudeSessionHost";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "cli",
  children: [ClaudeBridgeNode],
  create: (context) => {
    const viewsRoot = path.join(context.dataRootPath, "claude-config-views");
    const sessions = new ClaudeSessionHost({ viewsRoot });
    return {
      registrations: { claudeSessions: sessions },
      hasPendingWork: () => sessions.hasPendingWork(),
      start: () => ClaudeConfigView.sweep(viewsRoot),
      dispose: () => sessions.dispose(),
    };
  },
  description: "Restart Claude Code sessions, interrupting active Claude turns, and rebuild its bridge.",
  lifecycle: "atomic",
  provides: ["claudeSessions"],
  requires: [],
  safeAll: false,
  destructive: true,
  scope: "harness:claude",
});
