/*
 * Exports:
 * - WorkbenchAppReloadDirtControllerState: shared Git-backed dirt handoff state.
 * - WorkbenchAppReloadDirtControllerOptions: active graph source access and app snapshot ports.
 * - default WorkbenchAppReloadDirtController: preserve app dirt state and snapshot identity.
 */
import ReloadDirtController, {
  type ReloadDirtControllerState,
  type ReloadDirtSourceState,
} from "workbench-shared/reload/ReloadDirtController";

const APP_RELOAD_SNAPSHOT_REF = "refs/worktree/workbench/app-reload-snapshot";

export type WorkbenchAppReloadDirtControllerState = ReloadDirtControllerState;

export interface WorkbenchAppReloadDirtControllerOptions {
  getSourceState(): ReloadDirtSourceState;
  onChange?(): void;
  repositoryRootPath: string;
  watchSource?: typeof import("node:fs").watch;
}

function sharedStateOrNull(state: WorkbenchAppReloadDirtControllerState | object | undefined) {
  return state
    && "baselines" in state
    && state.baselines instanceof Map
    && "descriptors" in state
    && state.descriptors instanceof Map
    ? state as WorkbenchAppReloadDirtControllerState
    : null;
}

export default class WorkbenchAppReloadDirtController extends ReloadDirtController {
  constructor(
    options: WorkbenchAppReloadDirtControllerOptions,
    state?: WorkbenchAppReloadDirtControllerState | object,
  ) {
    super({
      getSourceState: options.getSourceState,
      onChange: options.onChange,
      repoRoot: options.repositoryRootPath,
      snapshotRef: APP_RELOAD_SNAPSHOT_REF,
      watchSource: options.watchSource,
    }, sharedStateOrNull(state));
  }
}
