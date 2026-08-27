/*
 * Exports:
 * - NORMAL_RELOAD_HOLD_MS/DESTRUCTIVE_RELOAD_HOLD_MS: user-confirmation durations for ordinary and destructive scopes. Keywords: reload, confirmation, duration.
 * - getReloadScopeHoldMs/getReloadAllHoldMs: derive user-confirmation duration from destructive scope metadata. Keywords: reload, confirmation, destructive.
 */
import type { WorkbenchReloadDirtScope } from "../../lib/types";

export const NORMAL_RELOAD_HOLD_MS = 500;
export const DESTRUCTIVE_RELOAD_HOLD_MS = 2_000;

export function getReloadScopeHoldMs(scope: WorkbenchReloadDirtScope) {
  return scope.destructive ? DESTRUCTIVE_RELOAD_HOLD_MS : NORMAL_RELOAD_HOLD_MS;
}

export function getReloadAllHoldMs(scopes: readonly WorkbenchReloadDirtScope[]) {
  return Math.max(NORMAL_RELOAD_HOLD_MS, ...scopes.map(getReloadScopeHoldMs));
}
