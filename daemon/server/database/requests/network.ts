/*
 * Exports:
 * - networkRequests: database requests for inbound agent network grants and requesting threads' approval history.
 */
import type { NetworkGrantCreate, NetworkGrantRevoke } from "workbench-shared/workbench/network/network-grants";
import WorkbenchNetworkGrantStore from "../../network/WorkbenchNetworkGrantStore.ts";
import WorkbenchNetworkHistoryStore, { type ThreadNetworkHistoryCommand } from "../../network/WorkbenchNetworkHistoryStore.ts";
import { defineDatabaseRequest } from "./define-database-request.ts";

export const networkRequests = {
  readNetworkGrantsForCaller: defineDatabaseRequest({
    read: "core",
    run: ({ database }, caller: { daemonId: string; threadId: string }) =>
      new WorkbenchNetworkGrantStore(database).forCaller(caller.daemonId, caller.threadId),
  }),
  createNetworkGrant: defineDatabaseRequest({
    run: ({ database }, input: { id: string; createdAt: number; grant: NetworkGrantCreate }) => new WorkbenchNetworkGrantStore(database).create(input),
  }),
  revokeNetworkGrants: defineDatabaseRequest({
    run: ({ database }, revoke: NetworkGrantRevoke) => new WorkbenchNetworkGrantStore(database).revoke(revoke),
  }),
  revokeNetworkGrantsTargeting: defineDatabaseRequest({
    run: ({ database }, threadId: string) => new WorkbenchNetworkGrantStore(database).revokeTargeting(threadId),
  }),
  executeThreadNetworkHistory: defineDatabaseRequest({
    run: ({ database }, command: ThreadNetworkHistoryCommand) => new WorkbenchNetworkHistoryStore(database).execute(command),
  }),
};
