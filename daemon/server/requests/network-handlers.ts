/*
 * Exports:
 * - networkRequestHandlers: app-only requests executing relayed calls and editing this daemon's network grants and history.
 */
import { NetworkGrantCreateSchema, NetworkGrantRevokeSchema } from "workbench-shared/workbench/network/network-grants";
import { RELAY_EXECUTE_METHOD, RelayExecuteParamsSchema } from "workbench-shared/workbench/network/network-relay-contracts";
import { defineDaemonRequestHandlers, InvalidParamsError, requiredString, type DaemonRequestContext } from "./daemon-request-handler";

function network(context: DaemonRequestContext) {
  const port = context.network();
  if (!port) throw new Error("Agent networking is reloading; retry shortly.");
  return port;
}

function parse<Value>(schema: { safeParse(value: unknown): { success: true; data: Value } | { success: false } }, params: unknown) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new InvalidParamsError("Invalid network request.");
  return parsed.data;
}

export const networkRequestHandlers = defineDaemonRequestHandlers({
  [RELAY_EXECUTE_METHOD]: async (params, context) => await network(context).execute(parse(RelayExecuteParamsSchema, params), context.signal),
  "network/grants/create": async (params, context) => ({ grant: await network(context).createGrant(parse(NetworkGrantCreateSchema, params)) }),
  "network/grants/list": async (_params, context) => ({ grants: await network(context).listGrants() }),
  "network/grants/revoke": async (params, context) => ({ revoked: await network(context).revokeGrants(parse(NetworkGrantRevokeSchema, params)) }),
  "network/history/revoke": async (params, context) => ({
    revoked: await network(context).revokeHistory(requiredString(params, "threadId"), requiredString(params, "entryId")),
  }),
});
