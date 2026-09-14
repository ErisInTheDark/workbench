/*
 * Exports:
 * - WorkbenchReloadDirtControllerState/WorkbenchReloadExternalDirtSource/WorkbenchReloadDirtControllerOptions: daemon-compatible shared dirt contracts.
 * - default WorkbenchReloadDirtController: add instruction-source observation and the daemon snapshot ref to shared Git reconciliation.
 */
import path from "node:path";

import ReloadDirtController, {
  type ReloadDirtControllerOptions,
  type ReloadDirtControllerState,
  type ReloadDirtExternalSource,
} from "workbench-shared/reload/ReloadDirtController";

import { setActiveReloadInstructionObserver } from "./lib/workbench/reload-source-observer";

const DAEMON_RELOAD_SNAPSHOT_REF = "refs/worktree/workbench/reload-snapshot";

export type WorkbenchReloadDirtControllerState = ReloadDirtControllerState;
export type WorkbenchReloadExternalDirtSource = ReloadDirtExternalSource;
export interface WorkbenchReloadDirtControllerOptions extends Omit<
  ReloadDirtControllerOptions,
  "connectSourceObserver" | "snapshotRef"
> {}

function toWorkspacePath(repoRoot: string, absolutePath: string) {
  const relative = path.relative(repoRoot, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : null;
}

export default class WorkbenchReloadDirtController extends ReloadDirtController {
  constructor(
    options: WorkbenchReloadDirtControllerOptions,
    state: WorkbenchReloadDirtControllerState | null = null,
  ) {
    super({
      ...options,
      connectSourceObserver: (observe) => setActiveReloadInstructionObserver((absolutePath) => {
        const sourcePath = toWorkspacePath(options.repoRoot, absolutePath);
        if (sourcePath) observe("server:instructions", sourcePath);
      }),
      snapshotRef: DAEMON_RELOAD_SNAPSHOT_REF,
    }, state);
  }
}
