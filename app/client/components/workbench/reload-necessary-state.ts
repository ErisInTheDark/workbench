/*
 * Exports:
 * - NORMAL_RELOAD_HOLD_MS/DESTRUCTIVE_RELOAD_HOLD_MS: user-confirmation durations for ordinary and destructive scopes. Keywords: reload, confirmation, duration.
 * - getReloadScopeHoldMs/getReloadAllHoldMs: derive user-confirmation duration from destructive scope metadata. Keywords: reload, confirmation, destructive.
 * - getAffectedReloadScopes: derive buttons affected by one reload selection from owner metadata. Keywords: reload, hover, dependants.
 * - mergeReloadDirt/partitionReloadScopes: combine snapshots and route scopes while full app restart subsumes client-node reloads. Keywords: reload, client, server.
 */
import type { WorkbenchReloadDirtScope, WorkbenchReloadDirtSnapshot } from "workbench-shared/types";

export const NORMAL_RELOAD_HOLD_MS = 500;
export const DESTRUCTIVE_RELOAD_HOLD_MS = 2_000;

export function getReloadScopeHoldMs(scope: WorkbenchReloadDirtScope) {
  return scope.destructive ? DESTRUCTIVE_RELOAD_HOLD_MS : NORMAL_RELOAD_HOLD_MS;
}

export function getReloadAllHoldMs(scopes: readonly WorkbenchReloadDirtScope[]) {
  return Math.max(NORMAL_RELOAD_HOLD_MS, ...scopes.map(getReloadScopeHoldMs));
}

export function getAffectedReloadScopes(
  hoveredScope: string | "all" | null,
  scopes: readonly WorkbenchReloadDirtScope[],
) {
  if (!hoveredScope) return new Set<string>();
  if (hoveredScope === "all") return new Set(scopes.map(({ scope }) => scope));
  return new Set(scopes.find(({ scope }) => scope === hoveredScope)?.dependantScopes ?? []);
}

export function mergeReloadDirt(
  client: WorkbenchReloadDirtSnapshot | null | undefined,
  server: WorkbenchReloadDirtSnapshot | null | undefined,
): WorkbenchReloadDirtSnapshot | null {
  if (!client && !server) return null;
  const dirty = new Map<string, WorkbenchReloadDirtScope>();
  for (const scope of [...client?.dirtyScopes ?? [], ...server?.dirtyScopes ?? []]) dirty.set(scope.scope, scope);
  const errors = [...new Set([client?.error, server?.error].filter((value): value is string => !!value))];
  return {
    dirtyScopes: [...dirty.values()],
    error: errors.length ? errors.join(" ") : null,
    pendingScopes: [...new Set([...client?.pendingScopes ?? [], ...server?.pendingScopes ?? []])],
  };
}

export function partitionReloadScopes(scopes: readonly string[]) {
  const client = scopes.filter((scope) => scope.startsWith("client:"));
  const host = scopes.filter((scope) => scope.startsWith("host:"));
  return {
    client: [
      ...(host.includes("host:process") ? ["host:process"] : host),
      ...(client.includes("client:process") ? ["client:process"] : client),
    ],
    server: scopes.filter((scope) => !scope.startsWith("client:") && !scope.startsWith("host:")),
  };
}
