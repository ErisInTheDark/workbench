/*
 * Exports:
 * - default OpenCodeBridgeNode: own OpenCode event subscription, canonical reconciliation, and WB thread operations.
 */
import ReloadableNode from "../../ReloadableNode";
import OpenCodeProvider from "./OpenCodeProvider";
import OpenCodeEventController from "./OpenCodeEventController";
import OpenCodeThreadOperations from "./OpenCodeThreadOperations";
import OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import OpenCodeTranscriptReader from "./OpenCodeTranscriptReader";
import OpenCodeManagedSessionController from "./OpenCodeManagedSessionController";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import { logError } from "../../process-helpers";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [OpenCodeProvider],
  create: (context, build) => {
    const service = build.get("openCodeService");
    const lifetime = new AbortController();
    let subscription: Promise<void> | null = null;
    const startSubscription = (client: Awaited<ReturnType<typeof service.acquire>>) => subscription ??= (async () => {
      for await (const event of client.event.subscribe({ signal: lifetime.signal })) {
        try {
          await events.accept(event);
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
    const reader = new OpenCodeTranscriptReader(
      request => build.get("transcript").read(request),
      threadId => build.get("transcript").readContextUsage(threadId),
    );
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
      signal: lifetime.signal,
    });
    const events = new OpenCodeEventController({
      invalidateModelCatalogs: () => service.invalidateModelCatalogs(),
      observe: async facts => {
        await build.get("providerObservations").observe("opencode", facts);
      },
      threads,
      transcript,
    });
    return {
      registrations: { openCodeThreadOperations: threads },
      start: () => undefined,
      dispose: async () => {
        lifetime.abort(new Error("OpenCode bridge disposed."));
        await Promise.all([subscription, threads.settle()]);
      },
    };
  },
  description: "Reload OpenCode request and event translation.",
  lifecycle: "atomic",
  provides: ["openCodeThreadOperations"],
  requires: [
    "openCodeService", "projectCatalog", "questionnaires", "threadIdentity", "transcriptIdentity",
    "threadState", "transcript", "providerObservations",
  ],
  safeAll: true,
  scope: "server:opencode",
  sources: [
    "daemon/server/providers/opencode/OpenCodeBridgeNode.ts",
    "daemon/server/providers/opencode/OpenCodeEventController.ts",
    "daemon/server/providers/opencode/OpenCodeThreadOperations.ts",
    "daemon/server/providers/opencode/OpenCodeManagedSessionController.ts",
    "daemon/server/providers/opencode/workbench-plugin/index.ts",
    "daemon/server/providers/opencode/workbench-plugin/CodeModeToolContextController.ts",
    "daemon/server/providers/opencode/OpenCodeTranscriptAdapter.ts",
    "daemon/server/providers/opencode/OpenCodeTranscriptReader.ts",
  ].join("\n"),
});
