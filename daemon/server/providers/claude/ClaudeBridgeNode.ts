/*
 * Exports:
 * - default ClaudeBridgeNode: own reloadable Claude session runtime, config views, lifecycle publication, native edit claim gating, and canonical transcript adapter.
 */
import path from "node:path";
import ReloadableNode from "../../ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import WorkbenchServerSettings from "../../lib/workbench/settings/WorkbenchServerSettings";
import {
  buildWorkbenchManagedThreadActivatedSkills,
  buildWorkbenchManagedThreadInstructions,
} from "../../lib/workbench/instructions/WorkbenchPromptFiles";
import ClaudeProviderNode from "./ClaudeProviderNode";
import ClaudeThreadOperations from "./ClaudeThreadOperations";
import ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";
import ClaudeConfigView from "./ClaudeConfigView";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [ClaudeProviderNode],
  create: (context, build) => {
    const lifetime = new AbortController();
    const settings = new WorkbenchServerSettings(build.get("database"));
    const transcript = new ClaudeTranscriptAdapter({
      threads: build.get("threadIdentity"),
      items: build.get("transcriptIdentity"),
      transcript: build.get("transcript"),
      assets: build.get("database"),
    });
    const viewsRoot = path.join(context.dataRootPath, "claude-config-views");
    const threads = new ClaudeThreadOperations({
      daemonOrigin: context.localDaemonOrigin,
      viewsRoot,
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
      checkFileClaims: ({ cwd, threadId, paths }) => build.get("gitArc").checkActiveClaimPaths(cwd, "claude", threadId, paths),
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
    return {
      registrations: { claudeThreadOperations: threads, claudeTranscriptAdapter: transcript },
      hasPendingWork: () => threads.hasPendingWork(),
      start: () => ClaudeConfigView.sweep(viewsRoot),
      dispose: async () => {
        lifetime.abort(new Error("Claude provider bridge disposed."));
        await threads.settle();
      },
    };
  },
  description: "Reload Claude Code session and transcript integration.",
  lifecycle: "atomic",
  provides: ["claudeThreadOperations", "claudeTranscriptAdapter"],
  requires: [
    "gitArc", "projectCatalog", "questionnaires", "approvals", "threadIdentity", "transcriptIdentity", "database",
    "threadState", "transcript", "transcriptReader", "providerObservations",
  ],
  safeAll: true,
  scope: "server:claude",
  sources: [
    "daemon/server/providers/claude/ClaudeBridgeNode.ts",
    "daemon/server/providers/claude/ClaudeThreadOperations.ts",
    "daemon/server/providers/claude/ClaudeLiveTurn.ts",
    "daemon/server/providers/claude/claude-prompt-content.ts",
    "daemon/server/providers/claude/ClaudeConfigView.ts",
    "daemon/server/providers/claude/claude-process-options.ts",
    "daemon/server/providers/claude/ClaudeTranscriptAdapter.ts",
    "daemon/server/providers/claude/claude-file-claim-hook.ts",
    "shared/workbench/provider/claude-file-change-metadata.ts",
    "daemon/server/lib/workbench/instructions/instruction-tool-reference.ts",
  ].join("\n"),
});
