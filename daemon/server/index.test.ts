/* No production exports. Tests protect the daemon process kernel from owning product code, so product edits never force a process restart. */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ProjectImportGraph from "./lib/workbench/ProjectImportGraph";

const root = realpathSync(path.resolve(import.meta.dirname, "../.."));
const entry = path.join(root, "daemon/server/index.ts");
/** Stable process, reload and host infrastructure; grow only deliberately. */
const KERNEL = new Set([
  "daemon/host/LinuxServiceStartup.ts",
  "daemon/host/WindowsServiceStartup.ts",
  "daemon/host/WorkbenchServiceLauncher.ts",
  "daemon/host/WorkbenchServiceStartup.ts",
  "daemon/host/host-environment-file.ts",
  "daemon/server/LinuxProcessGroupRetirement.ts",
  "daemon/server/ReloadableNodeHost.ts",
  "daemon/server/WorkbenchDaemonControlIngress.ts",
  "daemon/server/WorkbenchDaemonListener.ts",
  "daemon/server/codex-executable.ts",
  "daemon/server/daemon-process-context.ts",
  "daemon/server/index.ts",
  "daemon/server/lib/managed-npm-install.ts",
  "daemon/server/lib/workbench/ProjectImportGraph.ts",
  "daemon/server/network/network-relay-process-state.ts",
  "daemon/server/process-helpers.ts",
  "daemon/server/providers/provider-runtimes.ts",
  "daemon/server/reloadable-node-loader.ts",
  "package/workbench-daemon.d.mts",
  "package/workbench-data-root.d.mts",
  "shared/WorkbenchBusyLease.d.mts",
  "shared/database/database-log-format.ts",
  "shared/database/workbench-database-diagnostic.ts",
  "shared/http/workbench-daemon-discovery.ts",
  "shared/http/workbench-daemon-endpoint.ts",
  "shared/http/workbench-daemon-lifecycle.ts",
  "shared/http/workbench-network.ts",
  "shared/http/workbench-service.ts",
  "shared/process/NativeArtifactPublisher.ts",
  "shared/process/NativeArtifactStage.ts",
  "shared/process/WorkbenchProcessLease.ts",
  "shared/process/error-cause-chain.ts",
  "shared/process/workbench-daemon-endpoint.ts",
  "shared/process/workbench-service-endpoint.ts",
  "shared/reload/ReloadRetentionTracker.ts",
  "shared/reload/ReloadableNodeHost.ts",
  "shared/reload/ReloadableNodeTransition.ts",
  "shared/reload/reload-source-discovery.ts",
  "shared/reload/reloadable-node-loader.ts",
  "shared/reload/require-cache-generations.ts",
  "shared/reload/workbench-reload.ts",
  "shared/source-pattern-matcher.ts",
  "shared/workbench-data-root.ts",
  "shared/workbench/daemon-health.ts",
  "shared/workbench/daemon-reload.ts",
  "shared/workbench/provider/provider-runtime.ts",
]);

test("the daemon process kernel imports only its pinned process infrastructure", () => {
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const crossings = new ProjectImportGraph(root, [entry]).crossings(entry, new Set([...KERNEL].map(file => path.join(root, file))));
  if (crossings.length) assert.fail([
    "Every file the kernel imports restarts the daemon process when edited. Where it leaves its pinned infrastructure:",
    ...crossings.map(({ chain, pulled }) => `  ${chain.map(relative).join(" -> ")} (${pulled} files)`),
    "Keep product code out of the kernel (docs/invariants/hot-reload.md); extend KERNEL only with stable process infrastructure.",
  ].join("\n"));
});
