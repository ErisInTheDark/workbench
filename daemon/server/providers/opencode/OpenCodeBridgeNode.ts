/*
 * Exports:
 * - default OpenCodeBridgeNode: own OpenCode event subscription, canonical reconciliation, and WB thread operations.
 */
import ReloadableNode from "../../ReloadableNode";
import OpenCodeProvider from "./OpenCodeProvider";
import OpenCodeEventController from "./OpenCodeEventController";
import OpenCodeEventStreamController from "./OpenCodeEventStreamController";
import OpenCodeThreadOperations from "./OpenCodeThreadOperations";
import OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import OpenCodeManagedSessionController from "./OpenCodeManagedSessionController";
import WorkbenchServerSettings from "../../lib/workbench/settings/WorkbenchServerSettings";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import { logError } from "../../process-helpers";
import { OpenCodePatchObservationSchema } from "./opencode-workbench-rpc";
import { setTimeout as delay } from "node:timers/promises";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [OpenCodeProvider],
  create: (context, build) => {
    const service = build.get("openCodeService");
    const lifetime = new AbortController();
    let stream: OpenCodeEventStreamController;
    const acquire = async () => {
      const client = await service.acquire(lifetime.signal);
      stream.start();
      return client;
    };
    const transcript = new OpenCodeTranscriptAdapter({
      threads: build.get("threadIdentity"),
      items: build.get("transcriptIdentity"),
      transcript: build.get("transcript"),
      assets: build.get("database"),
      modelContext: async (model, directory, threadId) => {
        const identity = build.get("threadIdentity").knownThread(threadId);
        const profile = await build.get("threadState").controller.readComposerProfileSnapshot({
          kind: "thread",
          harness: "opencode",
          projectId: identity.projectId,
          threadId: identity.threadId,
        });
        if (profile?.settings.contextWindowTokens) return profile.settings.contextWindowTokens;
        const catalog = await service.readModelCatalog(directory);
        return catalog.models.find(candidate =>
          candidate.providerID === model.providerID && candidate.modelID === model.id
        )?.limit.context ?? null;
      },
    });
    const reader = build.get("transcriptReader");
    const readWorkingRecords = () => build.get("database").readThreadStateRecords({
      selection: "working", harness: "opencode",
    });
    const settings = new WorkbenchServerSettings(build.get("database"));
    const managed = new OpenCodeManagedSessionController({
      acquire,
      readInstructionTools: () => build.run("mcp", mcp => mcp.listInstructionTools(), "OpenCode instruction tool catalogue"),
      readLocalCapabilities: () => settings.readLocalCapabilities(),
      workbenchOrigin: context.localDaemonOrigin,
    });
    const threads = new OpenCodeThreadOperations({
      acquire,
      waitForCompactionConnection: signal => stream.waitForConnection(signal),
      observe: async facts => {
        await build.get("providerObservations").observe("opencode", facts);
      },
      identities: build.get("threadIdentity"),
      projects: build.get("projectCatalog"),
      questionnaires: build.get("questionnaires"),
      state: build.get("threadState"),
      managed,
      transcript,
      reader,
      reconciliation: build.get("transcriptReconciliation"),
      readWorkingRecords,
      readProviderCursor: (threadId, turnId) => build.get("database").readTranscriptProviderCursor!(threadId, turnId),
      signal: lifetime.signal,
      recovery: build.get("turnRecovery"),
      rollover: build.get("threadContextRollover"),
    });
    const events = new OpenCodeEventController({
      broadcast: notification => context.broadcastProviderNotification("opencode", notification),
      invalidateModelCatalogs: () => service.invalidateModelCatalogs(),
      observe: facts => build.get("providerObservations").observe("opencode", facts),
      rollover: build.get("threadContextRollover"),
      threads,
      transcript,
    });
    stream = new OpenCodeEventStreamController({
      subscribe: signal => ({
        async *[Symbol.asyncIterator]() {
          const client = await service.acquire(signal);
          yield* client.event.subscribe({ signal });
        },
      }),
      onConnected: ({ signal, wasTouched }) => events.reconcileConnection(signal, wasTouched),
      onEvent: async event => {
        if (String(event.type) === "rpc.workbench.patchPreview") {
          const parsed = OpenCodePatchObservationSchema.safeParse("data" in event ? event.data : undefined);
          if (!parsed.success) logError("opencode", "Invalid companion file-preview observation.");
          else events.acceptPatchPreview(parsed.data);
        } else await events.accept(event);
      },
      waitBeforeRetry: signal => delay(1000, undefined, { signal }),
      warn: message => logError("opencode", message),
    });
    return {
      hasPendingWork: () => stream.hasPendingWork() || threads.hasPendingWork(),
      registrations: {
        openCodeThreadOperations: threads,
        openCodeModelCatalog: {
          read: async (directory?: string) => {
            stream.start();
            return service.readModelCatalog(directory);
          },
        },
      },
      start: async () => {
        if ((await readWorkingRecords()).length) stream.start();
      },
      dispose: async () => {
        lifetime.abort(new Error("OpenCode bridge disposed."));
        await Promise.all([stream.dispose(), threads.settle()]);
        events.dispose();
      },
    };
  },
  description: "Reload OpenCode request and event translation.",
  lifecycle: "atomic",
  provides: ["openCodeThreadOperations", "openCodeModelCatalog"],
  requires: [
    "openCodeService", "projectCatalog", "questionnaires", "threadIdentity", "transcriptIdentity",
    "threadState", "transcript", "transcriptReader", "providerObservations", "transcriptReconciliation", "database", "turnRecovery",
    "threadContextRollover",
  ],
  safeAll: true,
  scope: "server:opencode",
});
