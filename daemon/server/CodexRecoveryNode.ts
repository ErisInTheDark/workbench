/*
 * Exports:
 * - default CodexRecoveryNode: retain native replay context across dependent bridge replacements.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexRecoveryController, { type CodexRecoveryControllerState } from "./CodexRecoveryController";
import CodexBridgeNode from "./CodexBridgeNode";
import CodexProvider from "./CodexProvider";
import { createInitializeCapabilities, createInitializeRequest } from "workbench-shared/codex/protocol";
import { recoverCodexTurn } from "./codex-turn-recovery";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [CodexBridgeNode, CodexProvider],
  create: (context, build) => {
    const coordinator = build.get("turnRecovery");
    const identities = build.get("threadIdentity");
    let owner!: CodexRecoveryController;
    const request = async (request: import("./bridge-types").JsonRpcRequest, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      owner.observeRequest("codex", request);
      if (context.isHardReloadPending()) throw new Error("The daemon is hard reloading; Codex recovery is paused.");
      const response = await build.run("codexBridge", async bridge => {
        signal?.throwIfAborted();
        await bridge.ensureInitialized(createInitializeRequest(0, {
          capabilities: createInitializeCapabilities({ experimentalApi: true }),
        }));
        signal?.throwIfAborted();
        return bridge.handleServerRequest(request, { signal });
      }, `Codex recovery: ${request.method}`);
      signal?.throwIfAborted();
      return response;
    };
    owner = new CodexRecoveryController({
      coordinator,
      log: context.logTurnRecovery,
      reportFailure: async candidate => {
        const params = candidate.request.params as { cwd?: string } | undefined;
        const cwd = typeof params?.cwd === "string" ? params.cwd.trim() : "";
        if (!cwd) {
          context.logTurnRecovery(`Codex recovery failure for ${candidate.threadId} has no cwd for lifecycle publication.`);
          return;
        }
        await context.reportTurnRecoveryFailure(cwd, "codex", candidate.threadId);
      },
      state: build.handoffState as CodexRecoveryControllerState | undefined,
      recover: (candidate, signal) => recoverCodexTurn(candidate, { request: message => request(message, signal) }),
      runTask: (label, task) => build.run("codexRecovery", current => {
        if (current !== owner) throw new Error("Codex recovery generation changed before scheduled work began.");
        return task();
      }, label),
      request,
      resolveThread: async threadId => {
        const identity = await identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId), harness: "codex" });
        const binding = identity?.bindings.find(binding => binding.harness === "codex");
        if (!binding) throw new Error("The managed thread has no Codex binding.");
        return binding.nativeThreadId;
      },
    });
    return {
      hasPendingWork: () => owner.hasPendingWork(),
      registrations: { codexRecovery: owner },
      start: () => undefined,
      beginRuntimeDrain: () => owner.beginRuntimeDrain(),
      expireRuntimeDrain: () => owner.expireRuntimeDrain(),
      listRuntimeDrainPending: () => owner.listRuntimeDrainPending(),
      beginHandoff: () => ({
        // The host drains native operation leases. A queued refresh must not hold
        // this handoff open while waiting to acquire the replacement's lease.
        waitForIdle: async () => { owner.beginRuntimeDrain(); },
        expire: () => owner.expireRuntimeDrain(),
        detach: () => { owner.expireRuntimeDrain(); return owner.captureReloadState(); },
        resume: () => owner.resumeAfterFailedReload(),
        commit: () => owner.expireRuntimeDrain(),
      }),
      captureReloadState: () => owner.captureReloadState(),
      dispose: () => { owner.expireRuntimeDrain(); },
    };
  },
  description: "Reload Codex captured turn context and native recovery.",
  lifecycle: "handoff",
  provides: ["codexRecovery"],
  requires: ["turnRecovery", "threadIdentity"],
  safeAll: true,
  scope: "server:codex/recovery",
  sources: "daemon/server/CodexRecoveryNode.ts\ndaemon/server/CodexRecoveryController.ts\ndaemon/server/codex-turn-recovery.ts",
});
