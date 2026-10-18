/*
 * Exports:
 * - workbenchDatabaseRequests/WorkbenchDatabaseRequestName: every registered database request by name; adding a request is one entry in a
 *   ./requests domain module.
 * - WorkbenchDatabaseRequestArgs/WorkbenchDatabaseRequestResult: one request's caller arguments and worker result.
 * - getWorkbenchDatabaseRequest: look a request up by its wire name.
 * - WorkbenchDatabaseRequestMethods: the controller methods the registry defines, one per request.
 */
import type { WorkbenchDatabaseRequestDefinition } from "./requests/define-database-request.ts";
import { gitRequests } from "./requests/git.ts";
import { identityRequests } from "./requests/identity.ts";
import { maintenanceRequests } from "./requests/maintenance.ts";
import { projectRequests } from "./requests/projects.ts";
import { statsRequests } from "./requests/stats.ts";
import { threadFactRequests } from "./requests/thread-facts.ts";
import { threadStateRequests } from "./requests/thread-state.ts";
import { transcriptRequests } from "./requests/transcript.ts";

export const workbenchDatabaseRequests = {
  ...gitRequests,
  ...identityRequests,
  ...maintenanceRequests,
  ...projectRequests,
  ...statsRequests,
  ...threadFactRequests,
  ...threadStateRequests,
  ...transcriptRequests,
};

export type WorkbenchDatabaseRequestName = keyof typeof workbenchDatabaseRequests;
type Run<Name extends WorkbenchDatabaseRequestName> = typeof workbenchDatabaseRequests[Name]["run"];
export type WorkbenchDatabaseRequestArgs<Name extends WorkbenchDatabaseRequestName> =
  Run<Name> extends (context: never, ...args: infer Args) => unknown ? Args : never;
export type WorkbenchDatabaseRequestResult<Name extends WorkbenchDatabaseRequestName> = ReturnType<Run<Name>>;

/** The registry seen through its common shape, for name-driven dispatch. */
export function getWorkbenchDatabaseRequest(name: string): WorkbenchDatabaseRequestDefinition<unknown[], unknown> | null {
  return Object.hasOwn(workbenchDatabaseRequests, name)
    ? workbenchDatabaseRequests[name as WorkbenchDatabaseRequestName] as unknown as WorkbenchDatabaseRequestDefinition<unknown[], unknown>
    : null;
}

export type WorkbenchDatabaseRequestMethods = {
  [Name in WorkbenchDatabaseRequestName]: (...args: WorkbenchDatabaseRequestArgs<Name>) => Promise<WorkbenchDatabaseRequestResult<Name>>;
};
