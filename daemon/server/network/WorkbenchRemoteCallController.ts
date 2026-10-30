/*
 * Exports:
 * - default WorkbenchRemoteCallController: execute a call another daemon's thread relayed here, only after authorizing it against
 *   this daemon's own grants and family records. Executed calls never relay onward: their ports have no relay.
 */
import { RelayExecuteParamsSchema, type RelayExecuteParams } from "workbench-shared/workbench/network/network-relay-contracts";
import type { RemoteCall, RemoteCallOutcome } from "workbench-shared/workbench/network/network-remote-calls";
import { remoteCallRegistry, type RemoteCallEntry, type RemoteCallPorts } from "./remote-call-registry";

function bounded(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}

export default class WorkbenchRemoteCallController {
  constructor(private readonly ports: RemoteCallPorts) {}

  async execute(input: RelayExecuteParams, signal: AbortSignal): Promise<RemoteCallOutcome> {
    const { caller, call } = RelayExecuteParamsSchema.parse(input);
    const entry = remoteCallRegistry[call.kind] as RemoteCallEntry<RemoteCall>;
    try {
      const authorization = await entry.authorize(this.ports, caller, call);
      if (!authorization.allowed) return { kind: "denied", need: authorization.need, failure: authorization.failure };
      signal.throwIfAborted();
      return await entry.execute(this.ports, caller, call, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { kind: "failed", failure: bounded(error) };
    }
  }
}
