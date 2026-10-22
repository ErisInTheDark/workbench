/*
 * Exports:
 * - RELOAD_HOLD_MS/UPDATE_HOLD_MS/DANGER_HOLD_MS: hold-to-confirm durations for plain reloads, plain updates and anything
 *   that restarts a process.
 * - ReloadImpact: what a reload would do that the user must know first: restarted processes and store migrations.
 * - ReloadDeviceFacts/ReloadDevicePlan: one device's dirt and update, and what its controls offer.
 * - mergeReloadDirt: this device's app and daemon dirt as one snapshot.
 * - restartLabel: the short process name a destructive scope restarts.
 * - reloadImpact: restarts and migrations across dirty scopes.
 * - planReloadDevice: derive one device's dirt tree, reload impact and update action.
 */
import { buildReloadDirtTree, type ReloadDirtNode } from "workbench-shared/reload/reload-dirt-tree";
import type { WorkbenchReloadDirtScope, WorkbenchReloadDirtSnapshot } from "workbench-shared/types";
import type { PredictedInstallationUpdate as InstallationUpdate } from "workbench-shared/workbench/installation-update-prediction";

export const RELOAD_HOLD_MS = 500;
export const UPDATE_HOLD_MS = 1_000;
export const DANGER_HOLD_MS = 2_000;

export interface ReloadImpact {
  /** Short names of restarted processes, such as `app` or `codex`. */
  restarts: string[];
  migrates: boolean;
}

export interface ReloadDeviceFacts {
  /** This device runs the app too, so its updates may install and restart it. */
  local: boolean;
  dirt: WorkbenchReloadDirtSnapshot | null;
  update: InstallationUpdate | null;
  /** Client and host scopes the app predicts this device's update dirties; local only. */
  appUpdateScopes?: readonly WorkbenchReloadDirtScope[] | null;
}

export interface ReloadDevicePlan {
  tree: ReloadDirtNode[];
  reload: (ReloadImpact & { danger: boolean; holdMs: number }) | null;
  /**
   * Pull and reload everything. `impact` is null while the update's dirt is unknown, which counts as dangerous.
   * `blocked` explains an update this app cannot run on that device.
   */
  update: {
    count: number;
    impact: ReloadImpact | null;
    danger: boolean;
    holdMs: number;
    blocked: string | null;
  } | null;
  /** An update that needs an agent instead of a pull. */
  issue: "conflict" | "failure" | null;
}

/** This device's app and daemon dirt as one snapshot; a scope both report appears once. */
export function mergeReloadDirt(
  app: WorkbenchReloadDirtSnapshot | null | undefined,
  daemon: WorkbenchReloadDirtSnapshot | null | undefined,
): WorkbenchReloadDirtSnapshot | null {
  if (!app && !daemon) return null;
  const dirty = new Map<string, WorkbenchReloadDirtScope>();
  for (const scope of [...app?.dirtyScopes ?? [], ...daemon?.dirtyScopes ?? []]) dirty.set(scope.scope, scope);
  const errors = [...new Set([app?.error, daemon?.error].filter((value): value is string => Boolean(value)))];
  return {
    dirtyScopes: [...dirty.values()],
    error: errors.length ? errors.join(" ") : null,
    pendingScopes: [...new Set([...app?.pendingScopes ?? [], ...daemon?.pendingScopes ?? []])],
  };
}

export function restartLabel(scope: string) {
  const [namespace = "", path = ""] = scope.split(":", 2);
  if (namespace === "client") return "app";
  if (namespace === "host") return "host";
  if (path === "process") return "daemon";
  return path.split("/")[0] || scope;
}

export function reloadImpact(scopes: readonly WorkbenchReloadDirtScope[]): ReloadImpact {
  return {
    restarts: [...new Set(scopes.filter(scope => scope.destructive).map(scope => restartLabel(scope.scope)))],
    migrates: scopes.some(scope => scope.migration),
  };
}

const INSTALL_SCOPE: WorkbenchReloadDirtScope = {
  scope: "client:install", description: "Install changed dependencies and restart the app.", destructive: true,
};

function updatePlan(facts: ReloadDeviceFacts, dirty: readonly WorkbenchReloadDirtScope[]): ReloadDevicePlan["update"] {
  const update = facts.update;
  if (!update || update.state !== "available" || !update.behind) return null;
  if (!facts.local && update.lockfileChanged) {
    return {
      count: update.behind, impact: null, danger: true, holdMs: DANGER_HOLD_MS,
      blocked: "Dependencies changed, so this update installs on that device. Update it from there.",
    };
  }
  const predicted = update.predictedScopes;
  const appPredicted = facts.local ? facts.appUpdateScopes : [];
  // Update & reload reloads everything afterwards, so what is already dirty joins the update's own dirt.
  const impact = predicted && appPredicted ? reloadImpact([
    ...dirty, ...predicted, ...appPredicted, ...update.lockfileChanged ? [INSTALL_SCOPE] : [],
  ]) : null;
  const danger = !impact || impact.restarts.length > 0;
  return { count: update.behind, impact, danger, holdMs: danger ? DANGER_HOLD_MS : UPDATE_HOLD_MS, blocked: null };
}

export function planReloadDevice(facts: ReloadDeviceFacts): ReloadDevicePlan {
  const dirty = facts.dirt?.dirtyScopes ?? [];
  const impact = reloadImpact(dirty);
  const danger = impact.restarts.length > 0;
  return {
    tree: buildReloadDirtTree(dirty),
    reload: dirty.length ? { ...impact, danger, holdMs: danger ? DANGER_HOLD_MS : RELOAD_HOLD_MS } : null,
    update: updatePlan(facts, dirty),
    issue: facts.update?.state !== "available" && facts.update?.state !== "conflict" ? null
      : facts.update.failure ? "failure" : facts.update.state === "conflict" ? "conflict" : null,
  };
}
