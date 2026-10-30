/*
 * Exports:
 * - default WorkbenchCoreNetworkFeature: build outbound agent networking over the process-wide app relay: target resolution,
 *   network prompts recorded in the caller's history, grant-backed calls that prompt once on refusal, family calls that never do,
 *   and ending settled threads' network access.
 */
import type { DaemonId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { NetworkAccessDecision } from "workbench-shared/workbench/network/network-grants";
import type { RemoteCall } from "workbench-shared/workbench/network/network-remote-calls";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchQuestionnaireController from "../interactions/WorkbenchQuestionnaireController";
import WorkbenchNetworkAccessController from "../network/WorkbenchNetworkAccessController";
import { getProcessNetworkRelay } from "../network/WorkbenchNetworkRelayController";
import type { DaemonDatabaseRegistration } from "../daemon-runtime-objects";
import WorkbenchNetworkSettlementController from "../network/WorkbenchNetworkSettlementController";
import type { RemoteSubagentNetwork } from "../subagents/WorkbenchRemoteSubagents";
import type WorkbenchThreadFactsFeature from "./WorkbenchThreadFactsFeature";

/** One settled thread's release to one daemon; that daemon may need to wake first. */
const SETTLEMENT_RELEASE_TIMEOUT_MS = 60_000;

export default class WorkbenchCoreNetworkFeature {
  readonly relay = getProcessNetworkRelay();
  readonly access: WorkbenchNetworkAccessController;
  readonly subagents: RemoteSubagentNetwork;
  private readonly historyStore: WorkbenchThreadFactsFeature["networkHistory"];
  readonly #settlement: WorkbenchNetworkSettlementController;
  readonly #stops: Array<() => void> = [];

  constructor(ports: {
    database: Pick<DaemonDatabaseRegistration, "revokeNetworkGrantsTargeting">;
    /** Built after this feature, read at call time. */
    questionnaires: () => Pick<WorkbenchQuestionnaireController, "request">;
    history: WorkbenchThreadFactsFeature["networkHistory"];
    warn(message: string): void;
  }) {
    this.historyStore = ports.history;
    this.#settlement = new WorkbenchNetworkSettlementController({
      revokeTargeting: threadId => ports.database.revokeNetworkGrantsTargeting(threadId),
      history: ports.history,
      release: async (caller, daemonId) => {
        await this.family(caller, daemonId, { kind: "release" }, AbortSignal.timeout(SETTLEMENT_RELEASE_TIMEOUT_MS));
      },
      warn: ports.warn,
    });
    const access = this.access = new WorkbenchNetworkAccessController({
      relay: this.relay,
      prompt: (caller, target, reason, signal) => ports.questionnaires().request({
        callerThreadId: caller.threadId, cwd: caller.cwd, questions: NetworkAccessDecision.questions(reason), networkAccess: { target },
      }, signal),
      recordApproval: (threadId, target) => ports.history.record(threadId, target),
    });
    this.subagents = {
      self: () => this.relay.self(),
      resolveFolder: async (caller, address, signal) => {
        const target = await access.resolveOne({ kind: "folder", address, callerProjectId: caller.projectId }, signal);
        if (target.kind !== "folder") throw new Error(`${address} is not a folder.`);
        return target;
      },
      call: async (caller, input, signal) => {
        const outcome = await access.call(caller, input, signal);
        return { text: outcome.text, data: outcome.data };
      },
      family: (caller, daemonId, call, signal) => this.family(caller, daemonId, call, signal),
    };
  }

  revokeHistory(threadId: WorkbenchThreadId, entryId: string) {
    return this.historyStore.revoke(threadId, entryId);
  }

  releaseOnSettlement(subscribe: (listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void) => () => void) {
    this.#stops.push(subscribe((_projectId, entry) => {
      if (entry.entryKind !== "draft" && entry.lifecycle.settled) void this.#settlement.settled({ threadId: entry.identity.threadId, title: entry.title });
    }));
  }

  stopObserving() {
    for (const stop of this.#stops.splice(0)) stop();
  }

  /** A call the target authorizes from its own records; a refusal is final. */
  async family(caller: { threadId: WorkbenchThreadId; title: string }, daemonId: DaemonId, call: RemoteCall, signal: AbortSignal) {
    // Callers often carry local context (cwd, project); the relay contract names only the calling thread.
    const outcome = await this.relay.request({
      kind: "execute", targetDaemonId: daemonId, caller: { threadId: caller.threadId, title: caller.title }, call,
    }, signal);
    if (outcome.kind !== "ok") throw new Error(outcome.failure);
    return { text: outcome.text, data: outcome.data as unknown };
  }
}
