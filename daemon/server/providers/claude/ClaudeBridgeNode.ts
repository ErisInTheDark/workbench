/*
 * Exports:
 * - default ClaudeBridgeNode: own reloadable Claude turn logic, placement of Workbench-built instructions, input-time agent context, lifecycle publication, native edit claim gating, tool batch ordering, model configuration probes, and canonical transcript adapter while preserving the parent harness's live processes.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import ReloadableNode from "../../runtime/ReloadableNode";
import { resolveProviderRuntime } from "../provider-runtimes";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import ClaudeConfigurationController from "./ClaudeConfigurationController";
import ClaudeProviderNode from "./ClaudeProviderNode";
import ClaudeThreadOperations, { type ClaudeTurnHandoff } from "./ClaudeThreadOperations";
import ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "../../agent/workbench-agent-mcp-request-registry";

interface ClaudeBridgeHandoff {
  turns: ClaudeTurnHandoff[];
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [ClaudeProviderNode],
  create: (context, build) => {
    const lifetime = new AbortController();
    const sessions = build.get("claudeSessions");
    const inherited = (build.handoffState as ClaudeBridgeHandoff | undefined)?.turns ?? [];
    // Turn launches resolve default windows here; the provider definition reads the same probes for model choices.
    // Resolved per launch, so an install from Settings applies to the very next turn or probe.
    const resolveExecutable = () => resolveProviderRuntime(context.dataRootPath, "claude", context.providerRuntimePins.claude()).executable;
    const configuration = new ClaudeConfigurationController(query, resolveExecutable);
    const transcript = new ClaudeTranscriptAdapter({
      threads: build.get("threadIdentity"),
      items: build.get("transcriptIdentity"),
      transcript: build.get("transcript"),
      assets: build.get("database"),
    });
    const threads = new ClaudeThreadOperations({
      daemonOrigin: context.localDaemonOrigin,
      workbenchRoot: context.legacyMigrationProjectRoot,
      sessions,
      observe: facts => build.get("providerObservations").observe("claude", facts),
      broadcast: notification => context.broadcastProviderNotification("claude", notification),
      identities: build.get("threadIdentity"),
      projects: build.get("projectCatalog"),
      questionnaires: build.get("questionnaires"),
      reader: build.get("transcriptReader"),
      reconciliation: build.get("transcriptReconciliation"),
      state: build.get("threadState"),
      transcript,
      signal: lifetime.signal,
      resolveExecutable,
      defaultContextWindow: model => configuration.defaultContextWindow(model),
      buildInstructions: async input => {
        const instructions = await build.get("threadInstructions").build({ ...input, harness: "claude" });
        return [instructions.baseInstructions, instructions.developerInstructions]
          .filter((part): part is string => Boolean(part?.trim())).join("\n\n");
      },
      collectInputContext: (threadId, trigger, signal) => (
        build.get("agentContext").collect({ harness: "claude", threadId }, trigger, signal)
      ),
    });
    const gitArc = build.get("gitArc");
    const threadWorkflow = build.get("threadWorkflow");
    let detachHooks: (() => Promise<void>) | null = null;
    const attachHooks = () => {
      detachHooks = sessions.attach({
        checkFileClaims: ({ cwd, threadId, paths }) => gitArc.checkActiveClaimPaths(cwd, "claude", threadId, paths),
        recordNativeToolDenial: (turnId, toolUseId) => transcript.recordNativeToolDenial(turnId, toolUseId),
        readModeToolDenial: ({ threadId, toolName }) => threadWorkflow.readToolDenial(threadId, toolName),
        toolBatch: getProcessWorkbenchAgentMcpRequestRegistry(),
      });
    };
    const releaseHooks = async () => {
      const detach = detachHooks;
      detachHooks = null;
      await detach?.();
    };
    // Retiring this generation never interrupts turns; only harness replacement and daemon shutdown do.
    const dispose = async () => {
      lifetime.abort(new Error("Claude provider bridge disposed."));
      await threads.dispose();
      configuration.dispose();
      await releaseHooks();
    };
    return {
      registrations: { claudeThreadOperations: threads, claudeTranscriptAdapter: transcript, claudeConfiguration: configuration },
      hasPendingWork: () => threads.hasPendingWork(),
      start: async () => {
        attachHooks();
        await threads.adopt(inherited);
      },
      beginHandoff: replacement => {
        const restartingHarness = replacement.isReplacing("harness:claude");
        return {
          // Turns are only paused in detach, after admitted operations such as submit have drained.
          waitForIdle: async () => undefined,
          expire: () => undefined,
          detach: async () => {
            let turns: ClaudeTurnHandoff[] = [];
            if (restartingHarness) await threads.interruptAll();
            else turns = await threads.pause();
            await releaseHooks();
            return { turns } satisfies ClaudeBridgeHandoff;
          },
          resume: () => {
            attachHooks();
            threads.resume();
          },
          commit: dispose,
        };
      },
      shutdown: () => threads.interruptAll(),
      dispose,
    };
  },
  description: "Reload Claude turn and transcript integration without restarting live Claude sessions.",
  lifecycle: "handoff",
  provides: ["claudeThreadOperations", "claudeTranscriptAdapter", "claudeConfiguration"],
  requires: [
    "claudeSessions", "gitArc", "projectCatalog", "questionnaires", "threadIdentity", "transcriptIdentity", "database",
    "threadState", "transcript", "transcriptReader", "transcriptReconciliation", "providerObservations", "agentContext",
    "threadWorkflow", "threadInstructions",
  ],
  safeAll: true,
  scope: "server:claude",
});
