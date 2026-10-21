/*
 * Exports:
 * - WORKBENCH_SANDBOX_SHELL_REQUIRES: graph registrations a node needs before it can prepare sandboxed shells.
 * - default createWorkbenchSandboxShell: the provider-facing admitted shell preparation; Codex's sandbox implements it for
 *   every provider.
 */
import type { ReloadableNodeBuild } from "workbench-shared/reload/ReloadableNode";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonRuntimeObjects } from "../daemon-runtime-objects";
import CodexShellController from "../providers/codex/CodexShellController";
import { requireWorkbenchPowerShellExecutable } from "../runtime/windows-powershell-runtime";

export const WORKBENCH_SANDBOX_SHELL_REQUIRES = ["codexExecutor", "codexSandboxAcl", "codexThreadOperations"] as const;

export default function createWorkbenchSandboxShell(
  context: Pick<DaemonProcessContext, "dataRootPath">,
  { get }: Pick<ReloadableNodeBuild<DaemonRuntimeObjects, typeof WORKBENCH_SANDBOX_SHELL_REQUIRES[number]>, "get">,
) {
  const shell = new CodexShellController({
    executor: get("codexExecutor"),
    sandboxAcl: get("codexSandboxAcl"),
    powerShellExecutable: () => requireWorkbenchPowerShellExecutable(context.dataRootPath),
    readConfiguration: cwd => get("codexThreadOperations").requestNative("config/read", { cwd, includeLayers: false }),
  });
  return shell.prepareAdmitted.bind(shell);
}
