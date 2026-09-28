/*
 * Exports:
 * - projectWorkbenchAppRuntimeSnapshot: project reload dirt and published frontend generation for workspace facts.
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
}) {
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
  const hostDirt = input.hostDirt;
  const combinedDirt = hostDirt ? {
    dirtyScopes: [...projectedDirt.dirtyScopes, ...hostDirt.dirtyScopes],
    pendingScopes: [...projectedDirt.pendingScopes, ...hostDirt.pendingScopes],
    error: [projectedDirt.error, hostDirt.error].filter(Boolean).join(" ").slice(0, 500) || null,
  } : projectedDirt;
  return {
    frontendGeneration: input.frontendGeneration,
    reloadDirt: combinedDirt,
  };
}
