/*
 * Exports:
 * - default OpenCodeBridgeNode: own OpenCode event subscription, canonical reconciliation, and WB thread operations.
 */
import ReloadableNode from "../../ReloadableNode";
import OpenCodeProvider from "./OpenCodeProvider";
import OpenCodeEventController from "./OpenCodeEventController";
import OpenCodeThreadOperations from "./OpenCodeThreadOperations";
import OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import OpenCodeManagedSessionController from "./OpenCodeManagedSessionController";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import { logError } from "../../process-helpers";
import { OpenCodePatchObservationSchema } from "./opencode-workbench-rpc";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [OpenCodeProvider],
  create: (context, build) => {
    const service = build.get("openCodeService");
    const lifetime = new AbortController();
    let subscription: Promise<void> | null = null;
    let processingEvent: Promise<void> | null = null;
    const startSubscription = (client: Awaited<ReturnType<typeof service.acquire>>) => subscription ??= (async () => {
      for await (const event of client.event.subscribe({ signal: lifetime.signal })) {
        try {
          if (String(event.type) === "rpc.workbench.patchPreview") {
            const parsed = OpenCodePatchObservationSchema.safeParse("data" in event ? event.data : undefined);
            if (!parsed.success) logError("opencode", "Invalid companion file-preview observation.");
            else events.acceptPatchPreview(parsed.data);
          } else {
            processingEvent = events.accept(event);
            try { await processingEvent; }
            finally { processingEvent = null; }
          }
        } catch (error) {
          if (!lifetime.signal.aborted) {
            logError("opencode", `event reconciliation failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
          }
        }
      }
    })().catch(error => {
      if (!lifetime.signal.aborted) {
        logError("opencode", `event subscription failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
      }
    });
    const acquire = async () => {
      const client = await service.acquire(lifetime.signal);
      void startSubscription(client);
      return client;
    };
    const transcript = new OpenCodeTranscriptAdapter({
      threads: build.get("threadIdentity"),
      items: build.get("transcriptIdentity"),
      transcript: build.get("transcript"),
      modelContext: async (model, directory) => {
        const catalog = await service.readModelCatalog(directory);
        return catalog.models.find(candidate =>
          candidate.providerID === model.providerID && candidate.modelID === model.id
        )?.limit.context ?? null;
      },
    });
    const reader = build.get("transcriptReader");
    const managed = new OpenCodeManagedSessionController({
      acquire,
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
      invalidateModelCatalogs: () => service.invalidateModelCatalogs(),
      observe: facts => build.get("providerObservations").observe("opencode", facts),
      threads,
      transcript,
    });
    return {
      hasPendingWork: () => processingEvent !== null || threads.hasPendingWork(),
      registrations: { openCodeThreadOperations: threads },
      start: () => undefined,
      dispose: async () => {
        lifetime.abort(new Error("OpenCode bridge disposed."));
        await Promise.all([subscription, threads.settle()]);
        events.dispose();
      },
    };
  },
  description: "Reload OpenCode request and event translation.",
  lifecycle: "atomic",
  provides: ["openCodeThreadOperations"],
  requires: [
    "openCodeService", "projectCatalog", "questionnaires", "threadIdentity", "transcriptIdentity",
    "threadState", "transcript", "transcriptReader", "providerObservations", "transcriptReconciliation", "database", "turnRecovery",
  ],
  safeAll: true,
  scope: "server:opencode",
  sources: [
    "daemon/server/providers/opencode/OpenCodeBridgeNode.ts",
    "daemon/server/providers/opencode/OpenCodeEventController.ts",
    "daemon/server/providers/opencode/OpenCodeThreadOperations.ts",
    "daemon/server/providers/opencode/OpenCodeThreadWindowLoader.ts",
    "daemon/server/providers/opencode/OpenCodeManagedSessionController.ts",
    "daemon/server/providers/opencode/OpenCodeTranscriptAdapter.ts",
  ].join("\n"),
});
