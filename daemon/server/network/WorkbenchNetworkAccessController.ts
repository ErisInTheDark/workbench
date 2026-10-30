/*
 * Exports:
 * - NetworkCaller: the local thread behind an outbound networked command.
 * - NetworkDeniedError: the user did not approve, or the target refused even after approval.
 * - default WorkbenchNetworkAccessController: resolve agents' remote targets, prompt the user when a target refuses for lack of a
 *   grant, record approvals in the caller's history, and dispatch each relayed call once per approval.
 */
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchUserInputResponse } from "workbench-shared/types";
import { NetworkAccessDecision, type NetworkTarget } from "workbench-shared/workbench/network/network-access";
import { NetworkGrant } from "workbench-shared/workbench/network/network-grants";
import type { RelayResolveTarget } from "workbench-shared/workbench/network/network-relay-contracts";
import type { RemoteCall } from "workbench-shared/workbench/network/network-remote-calls";
import type WorkbenchNetworkRelayController from "./WorkbenchNetworkRelayController";

export interface NetworkCaller {
  threadId: WorkbenchThreadId;
  cwd: string;
  title: string;
  projectId: ProjectId;
}

export class NetworkDeniedError extends Error {}

export default class WorkbenchNetworkAccessController {
  constructor(private readonly ports: {
    relay: Pick<WorkbenchNetworkRelayController, "request">;
    /** Raises a network prompt on the caller's thread and waits for the user's answer. */
    prompt(caller: NetworkCaller, target: NetworkTarget, reason: string, signal: AbortSignal): Promise<WorkbenchUserInputResponse>;
    recordApproval(threadId: WorkbenchThreadId, target: NetworkTarget): Promise<unknown>;
  }) {}

  async resolve(targets: readonly RelayResolveTarget[], signal: AbortSignal): Promise<NetworkTarget[]> {
    const { targets: resolved } = await this.ports.relay.request({ kind: "resolve", targets: [...targets] }, signal);
    const failures = resolved.flatMap(item => item.kind === "failed" ? [item.failure] : []);
    if (failures.length || resolved.length !== targets.length) throw new Error(failures.join("\n") || "Some targets could not be resolved.");
    return resolved.flatMap(item => item.kind === "resolved" ? [item.target] : []);
  }

  async resolveOne(target: RelayResolveTarget, signal: AbortSignal) {
    return (await this.resolve([target], signal))[0]!;
  }

  /** Asks the user; approval means an app wrote the grant onto the target before answering. */
  async approve(caller: NetworkCaller, target: NetworkTarget, reason: string, signal: AbortSignal) {
    const response = await this.ports.prompt(caller, target, reason, signal);
    if (!NetworkAccessDecision.approved(response)) return false;
    await this.ports.recordApproval(caller.threadId, target);
    return true;
  }

  /**
   * Dispatches `call` to the target daemon, which authorizes it against its own grants. A refusal raises a prompt for
   * `target()`; once approved, the call is dispatched once more as a new request.
   */
  async call(caller: NetworkCaller, input: {
    daemonId: NetworkTarget["daemonId"];
    call: RemoteCall;
    reason: string;
    target: () => Promise<NetworkTarget>;
  }, signal: AbortSignal) {
    const dispatch = () => this.ports.relay.request({
      kind: "execute", targetDaemonId: input.daemonId, caller: { threadId: caller.threadId, title: caller.title }, call: input.call,
    }, signal);
    const first = await dispatch();
    if (first.kind === "ok") return first;
    if (first.kind === "failed" || !first.need) throw new Error(first.failure);
    const target = await input.target();
    if (!await this.approve(caller, target, input.reason, signal)) {
      throw new NetworkDeniedError(`The user did not let this thread reach ${NetworkGrant.targetLabel(target)} on ${target.hostname}.`);
    }
    const second = await dispatch();
    if (second.kind === "ok") return second;
    throw new NetworkDeniedError(second.failure);
  }

  /** `wb network request`: ask for every target up front; returns one line per target. */
  async request(caller: NetworkCaller, targets: readonly RelayResolveTarget[], reason: string, signal: AbortSignal) {
    const resolved = await this.resolve(targets, signal);
    const lines: string[] = [];
    for (const target of resolved) {
      const approved = await this.approve(caller, target, reason, signal);
      lines.push(`${approved ? "Approved" : "Denied"}: ${describe(target)}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export function describe(target: NetworkTarget) {
  if (target.kind === "thread") return `thread ${target.threadId} "${target.title}" (${target.projectName}) on ${target.hostname}`;
  if (target.kind === "folder") return `folder ${target.rootPath} on ${target.hostname}`;
  return `${target.rootPath ? `feedback for ${target.rootPath}` : "wb feedback for all projects"} on ${target.hostname}`;
}
