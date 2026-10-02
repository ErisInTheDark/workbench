/*
 * Exports:
 * - default ClaudeBridgeNode: own reloadable Claude turn logic, lifecycle publication, native edit claim gating, and canonical transcript adapter while preserving the parent harness's live processes.
 */
import ReloadableNode from "../../ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import WorkbenchServerSettings from "../../lib/workbench/settings/WorkbenchServerSettings";
import {
  buildWorkbenchManagedThreadActivatedSkills,
  buildWorkbenchManagedThreadInstructions,
} from "../../lib/workbench/instructions/WorkbenchPromptFiles";
import ClaudeProviderNode from "./ClaudeProviderNode";
import ClaudeThreadOperations, { type ClaudeTurnHandoff } from "./ClaudeThreadOperations";
import ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";

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
    const settings = new WorkbenchServerSettings(build.get("database"));
    const transcript = new ClaudeTranscriptAdapter({
      threads: build.get("threadIdentity"),
      items: build.get("transcriptIdentity"),
      transcript: build.get("transcript"),
      assets: build.get("database"),
    });
    const threads = new ClaudeThreadOperations({
      daemonOrigin: context.localDaemonOrigin,
      sessions,
      observe: facts => build.get("providerObservations").observe("claude", facts),
      broadcast: notification => context.broadcastProviderNotification("claude", notification),
      identities: build.get("threadIdentity"),
      projects: build.get("projectCatalog"),
      questionnaires: build.get("questionnaires"),
      approvals: build.get("approvals"),
      reader: build.get("transcriptReader"),
      state: build.get("threadState"),
      transcript,
      signal: lifetime.signal,
      buildInstructions: async input => {
        const project = await build.get("projectCatalog").resolveProjectById(input.projectId);
        const promptContext = {
          ...input,
          roots: project.roots.map(root => ({
            id: root.id, name: root.name, relativePath: root.relativePath ?? ".",
            rootPath: root.rootPath, isPrimary: root.rootPath === project.rootPath,
          })),
          harness: "claude" as const, managedThread: true,
          readInstructionTools: () => build.run("mcp", mcp => mcp.listInstructionTools(), "Claude instruction tool catalogue"),
          workbenchOrigin: context.localDaemonOrigin,
        };
        const [instructions, activatedSkills] = await Promise.all([
          buildWorkbenchManagedThreadInstructions(promptContext, () => settings.readLocalCapabilities()),
          buildWorkbenchManagedThreadActivatedSkills(promptContext, () => settings.readLocalCapabilities()),
        ]);
        return [instructions.baseInstructions, instructions.developerInstructions, activatedSkills]
          .filter((part): part is string => Boolean(part?.trim())).join("\n\n");
      },
    });
    const gitArc = build.get("gitArc");
    let detachHooks: (() => Promise<void>) | null = null;
    const attachHooks = () => {
      detachHooks = sessions.attach({
        checkFileClaims: ({ cwd, threadId, paths }) => gitArc.checkActiveClaimPaths(cwd, "claude", threadId, paths),
        recordNativeToolDenial: (turnId, toolUseId) => transcript.recordNativeToolDenial(turnId, toolUseId),
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
      await releaseHooks();
    };
    return {
      registrations: { claudeThreadOperations: threads, claudeTranscriptAdapter: transcript },
      hasPendingWork: () => threads.hasPendingWork(),
      start: () => {
        attachHooks();
        threads.adopt(inherited);
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
  provides: ["claudeThreadOperations", "claudeTranscriptAdapter"],
  requires: [
    "claudeSessions", "gitArc", "projectCatalog", "questionnaires", "approvals", "threadIdentity", "transcriptIdentity", "database",
    "threadState", "transcript", "transcriptReader", "providerObservations",
  ],
  safeAll: true,
  scope: "server:claude",
});
