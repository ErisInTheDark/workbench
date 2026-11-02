/* No production exports. Tests protect the app process kernel from owning product code, so product edits never force a process restart. */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const { default: ProjectImportGraph } = createRequire(import.meta.url)(
  "../../daemon/server/lib/workbench/ProjectImportGraph.ts",
) as typeof import("../../daemon/server/lib/workbench/ProjectImportGraph");

const root = realpathSync(path.resolve(import.meta.dirname, "../.."));
const entry = path.join(root, "app/server/index.ts");
/** Stable process, reload and frontend-serving infrastructure; grow only deliberately. */
const KERNEL = new Set([
  "app/server/WorkbenchApp.ts",
  "app/server/WorkbenchAppControl.ts",
  "app/server/WorkbenchAppProcess.ts",
  "app/server/WorkbenchAppProcessProtocol.ts",
  "app/server/WorkbenchFrontendServer.ts",
  "app/server/app-command-line.ts",
  "app/server/index.ts",
  "app/server/runtime/WorkbenchAppRuntime.ts",
  "app/server/runtime/workbench-app-runtime-snapshot.ts",
  "app/server/workbench-runtime-root.ts",
  "package/workbench-data-root.d.mts",
  "shared/WorkbenchBusyLease.d.mts",
  "shared/http/HttpServer.ts",
  "shared/http/workbench-app-control.ts",
  "shared/http/workbench-daemon-discovery.ts",
  "shared/http/workbench-daemon-endpoint.ts",
  "shared/http/workbench-network.ts",
  "shared/http/workbench-service.ts",
  "shared/process/WorkbenchProcessLease.ts",
  "shared/process/WorkbenchProcessLogger.ts",
  "shared/process/error-cause-chain.ts",
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
  "shared/workbench/deep-equality.ts",
  "shared/workbench/identity.ts",
  "shared/workbench/installation-update.ts",
]);

test("the app process kernel imports only its pinned process infrastructure", () => {
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const crossings = new ProjectImportGraph(root, [entry]).crossings(entry, new Set([...KERNEL].map(file => path.join(root, file))));
  if (crossings.length) assert.fail([
    "Every file the kernel imports restarts the app process when edited. Where it leaves its pinned infrastructure:",
    ...crossings.map(({ chain, pulled }) => `  ${chain.map(relative).join(" -> ")} (${pulled} files)`),
    "Keep product code out of the kernel (docs/invariants/hot-reload.md); extend KERNEL only with stable process infrastructure.",
  ].join("\n"));
});
