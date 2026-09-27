/*
 * Exports:
 * - projectWorkbenchAppRuntimeSnapshot: one HTTP/RPC projection of reload dirt and published frontend generation.
 */
import type { WorkbenchFrontendGeneration } from "workbench-shared/types";
import type { WorkbenchReloadDirtSnapshot, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";

export function projectWorkbenchAppRuntimeSnapshot(input: {
  allScopes: readonly WorkbenchReloadScope[];
  appliedReactDevelopmentMode: boolean | null;
  frontendGeneration: WorkbenchFrontendGeneration | null;
  hostDirt: WorkbenchReloadDirtSnapshot | null;
  reloadDirt: WorkbenchReloadDirtSnapshot;
  requestedReactDevelopmentMode: boolean;
}, version: string | null = "4") {
  const projectedDirt = input.requestedReactDevelopmentMode !== input.appliedReactDevelopmentMode
    && !input.reloadDirt.dirtyScopes.some(({ scope }) => scope === "client:process")
    ? {
        ...input.reloadDirt,
        dirtyScopes: [
          ...input.reloadDirt.dirtyScopes,
          {
            dependantScopes: input.allScopes,
            description: "Restart the Workbench app to apply app-wide settings.",
            destructive: true,
            scope: "client:process" as const,
          },
        ],
      }
    : input.reloadDirt;
  const hostDirt = version === "4" ? input.hostDirt : null;
  const combinedDirt = hostDirt ? {
    dirtyScopes: [...projectedDirt.dirtyScopes, ...hostDirt.dirtyScopes],
    pendingScopes: [...projectedDirt.pendingScopes, ...hostDirt.pendingScopes],
    error: [projectedDirt.error, hostDirt.error].filter(Boolean).join(" ").slice(0, 500) || null,
  } : projectedDirt;
  const includeDependants = version === "2" || version === "3" || version === "4";
  return {
    ...(version === "3" || version === "4"
      ? { frontendGeneration: input.frontendGeneration } : {}),
    reloadDirt: includeDependants ? combinedDirt : {
      ...combinedDirt,
      dirtyScopes: combinedDirt.dirtyScopes.map(({ dependantScopes: _dependantScopes, ...scope }) => scope),
    },
  };
}
