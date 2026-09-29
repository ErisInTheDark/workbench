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
      modelContext: async (model, directory) => {
        const catalog = await service.readModelCatalog(directory);
        return catalog.models.find(candidate =>
          candidate.providerID === model.providerID && candidate.modelID === model.id
        )?.limit.context ?? null;
      },
    });
    const reader = build.get("transcriptReader");
    const settings = new WorkbenchServerSettings(build.get("database"));
    const managed = new OpenCodeManagedSessionController({
      acquire,
      readLocalCapabilities: () => settings.readLocalCapabilities(),
      workbenchOrigin: context.localDaemonOrigin,
    });
    const threads = new OpenCodeThreadOperations({
      acquire,
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
      readProviderCursor: (threadId, turnId) => build.get("database").readTranscriptProviderCursor!(threadId, turnId),
      signal: lifetime.signal,
      recovery: build.get("turnRecovery"),
    });
    const events = new OpenCodeEventController({
      broadcast: notification => context.broadcastProviderNotification("opencode", notification),
      invalidateModelCatalogs: () => service.invalidateModelCatalogs(),
      observe: facts => build.get("providerObservations").observe("opencode", facts),
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
      start: () => undefined,
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
  ],
  safeAll: true,
  scope: "server:opencode",
  sources: [
    "daemon/server/providers/opencode/OpenCodeBridgeNode.ts",
    "daemon/server/providers/opencode/OpenCodeEventController.ts",
    "daemon/server/providers/opencode/OpenCodeEventStreamController.ts",
    "daemon/server/providers/opencode/OpenCodeThreadOperations.ts",
    "daemon/server/providers/opencode/OpenCodeThreadWindowLoader.ts",
    "daemon/server/providers/opencode/OpenCodeManagedSessionController.ts",
    "daemon/server/providers/opencode/OpenCodeTranscriptAdapter.ts",
    "daemon/server/codex-transcript-image-assets.ts",
    "daemon/server/lib/workbench/instructions/instruction-context-filter.ts",
  ].join("\n"),
});
