/*
 * Exports:
 * - WORKBENCH_SANDBOX_SHELL_REQUIRES: graph registrations a node needs before it can prepare sandboxed shells.
 * - createWorkbenchShellController: the Codex-sandboxed shell controller every provider's admitted commands share.
 * - default createWorkbenchSandboxShell: the provider-facing admitted shell preparation; Codex's sandbox implements it for
 *   every provider.
 */
import type { ReloadableNodeBuild } from "workbench-shared/reload/ReloadableNode";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonRuntimeObjects } from "../daemon-runtime-objects";
import CodexShellController from "../providers/codex/CodexShellController";
import { requireWorkbenchPowerShellExecutable } from "../runtime/windows-powershell-runtime";

export const WORKBENCH_SANDBOX_SHELL_REQUIRES = ["codexExecutor", "codexSandboxAcl", "codexWindowsSandbox"] as const;

type SandboxShellBuild = Pick<ReloadableNodeBuild<DaemonRuntimeObjects, typeof WORKBENCH_SANDBOX_SHELL_REQUIRES[number]>, "get">;

export function createWorkbenchShellController(context: Pick<DaemonProcessContext, "dataRootPath">, { get }: SandboxShellBuild) {
  return new CodexShellController({
    executor: get("codexExecutor"),
    sandboxAcl: get("codexSandboxAcl"),
    windowsSandbox: get("codexWindowsSandbox"),
    powerShellExecutable: () => requireWorkbenchPowerShellExecutable(context.dataRootPath),
  });
}

export default function createWorkbenchSandboxShell(context: Pick<DaemonProcessContext, "dataRootPath">, build: SandboxShellBuild) {
  const shell = createWorkbenchShellController(context, build);
  return shell.prepareAdmitted.bind(shell);
}
