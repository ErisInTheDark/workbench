/*
 * Exports:
 * - default WorkbenchAgentCommandNode: own shared wb CLI and MCP command execution below core and above MCP adaptation. Keywords: agent command, CLI, MCP, questionnaire, reload graph.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import { WorkbenchRequestUserInputCommandSchema } from "../lib/workbench/commands/questionnaire-command-definition";
import WorkbenchThreadRecallController from "../lib/workbench/thread/WorkbenchThreadRecallController";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import WorkbenchAgentCommandLogger from "./WorkbenchAgentCommandLogger";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchTokenCountController from "./WorkbenchTokenCountController";
import WorkbenchClaimStatsController from "./WorkbenchClaimStatsController";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [WorkbenchMcpNode],
  create: (context, build) => {
    const gitArc = build.get("gitArc");
    const harnesses = build.get("harnesses");
    const projectCatalog = build.get("projectCatalog");
    const database = build.get("database");
    const threadIdentity = build.get("threadIdentity");
    const transcriptIdentity = build.get("transcriptIdentity");
    const nativeTarget = async (threadId: string, cwd: string, harness?: string) => {
      const project = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench command" });
      const identity = await harnesses.resolveThreadIdentity({ threadId, projectId: project.project.id, ...(harness ? { harness: WorkbenchHarnessSchema.parse(harness) } : {}) });
      if (!identity?.bindings[0]) throw new Error("The managed thread has no native execution in this project.");
      return { identity, binding: identity.bindings[0] };
    };
    const claimStats = new WorkbenchClaimStatsController({
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Claim statistics" }),
      read: async (request) => await database.readClaimStats(request),
    });
    const questionnaires = build.get("questionnaires");
    const subagents = build.get("subagents");
    const threadState = build.get("threadState");
    const transcript = build.get("transcript");
    const reloadDirt = build.get("reloadDirt");
    const tokens = new WorkbenchTokenCountController({
      projectRoot: context.legacyMigrationProjectRoot,
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, {
        endpointName: "Project token counting",
      }),
    });
    const commandLogger = new WorkbenchAgentCommandLogger();
    const materializeTurn = async (threadId: string, turnId: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      const identity = await harnesses.resolveThreadIdentity({ threadId });
      const turn = turnId && identity ? await threadIdentity.resolveTurn({ threadId: identity.threadId, turnId }) : null;
      const binding = turn?.native ?? identity?.bindings[0];
      if (!binding || (turnId && !turn) || binding.harness !== "codex") throw new Error("Thread Recall has no matching native Codex execution.");
      const response = await harnesses.request("codex", {
        id: 0,
        method: "workbench/thread-recall/materialize",
        params: { threadId: binding.nativeThreadId, turnId: turn?.native.nativeTurnId ?? null },
      });
      signal.throwIfAborted();
      if (response.error) throw new Error(response.error.message);
    };
    const threadRecall = new WorkbenchThreadRecallController({
      materializeTurn,
      readTranscript: async (request) => await transcript.read(request),
      resolveReference: async (threadId, locator, signal) => {
        const turn = await threadIdentity.resolveTurn({ threadId, turnId: locator.turnId });
        if (!turn) throw new Error("Thread Recall cursor has no matching turn.");
        const snapshot = await transcript.read({ threadId, turnIds: [turn.turnId], turnLimit: 1 });
        if (!snapshot) {
          await materializeTurn(threadId, turn.turnId, signal);
          await transcript.read({ threadId, turnIds: [turn.turnId], turnLimit: 1 });
        }
        signal.throwIfAborted();
        const item = await transcriptIdentity.resolve({ threadId, turnId: turn.turnId, itemId: locator.itemId });
        if (!item) throw new Error("Thread Recall cursor has no matching item.");
        return { ...locator, turnId: turn.turnId, itemId: item.itemId };
      },
      resolveProjectFromCwd: async (cwd) => {
        await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, {
          endpointName: "Thread Recall",
        });
      },
    });
    const agentCommand = new WorkbenchAgentCommandController(context.localOrchestratorOrigin, {
      checkApplyPatchClaims: async ({ cwd, harness, paths, threadId }) => await gitArc.checkActiveClaimPaths(cwd, harness, threadId, paths),
      executeBrowseRequest: context.executeBrowseRequest,
      executeGitArcRequest: async (body, signal) => await gitArc.executeRequest(body, signal),
      executeQuestionnaireRequest: async (body, signal) => {
        const request = WorkbenchRequestUserInputCommandSchema.parse(body);
        const { binding } = await nativeTarget(request.callerThreadId, request.cwd, "codex");
        return Response.json(await questionnaires.request({ ...request, callerThreadId: binding.nativeThreadId }, signal));
      },
      executeThreadGitRequest: async (body, signal) => {
        signal.throwIfAborted();
        return await build.get("threadGit").executeRequest(body);
      },
      executeThreadRecallRequest: async (request, signal) => {
        const url = new URL(request.path, context.localOrchestratorOrigin);
        const prefix = "/api/thread-context/";
        if (!url.pathname.startsWith(prefix)) throw new Error("Invalid Thread Recall command path.");
        signal.throwIfAborted();
        const identity = await harnesses.resolveThreadIdentity({ threadId: decodeURIComponent(url.pathname.slice(prefix.length)) });
        if (!identity) throw new Error("Thread Recall has no matching Workbench thread.");
        signal.throwIfAborted();
        return await threadRecall.execute({
          body: request.body,
          method: request.method,
          searchParams: url.searchParams,
          threadId: identity.threadId,
        }, signal);
      },
      executeTokenCount: async (body, signal) => await tokens.execute(body, signal),
      executeClaimStats: async (body, signal) => await claimStats.execute(body, signal),
      executeSessionRequest: context.executeBrowseSessionRequest,
      getReloadScopeCatalog: () => reloadDirt.getCatalog(),
      resolveCaller: async (threadId, cwd, harness) => {
        const { identity, binding } = await nativeTarget(threadId, cwd, harness);
        return { threadId: identity.threadId, nativeThreadId: binding.nativeThreadId, harness: WorkbenchHarnessSchema.parse(binding.harness) };
      },
      readReloadDirtSnapshot: () => reloadDirt.getSnapshot(),
      requestCodex: async (request) => await harnesses.request("codex", request),
      requestSubagent: async (request) => request.method?.startsWith("workbench/thread/")
        ? await threadState.handleManagedThreadRequest(request)
        : await subagents.handleRequest(request),
      workbenchProjectRoot: context.legacyMigrationProjectRoot,
    }, undefined, undefined, commandLogger);
    return {
      beginRuntimeDrain: () => { agentCommand.beginRuntimeDrain(); },
      dispose: async () => { await agentCommand.dispose(); },
      listRuntimeDrainPending: () => agentCommand.listRuntimeDrainPending(),
      registrations: { agentCommand },
      start: () => undefined,
    };
  },
  description: "Reload shared wb CLI and MCP command execution without replacing core state.",
  lifecycle: "atomic",
  provides: ["agentCommand"],
  requires: ["database", "gitArc", "harnesses", "projectCatalog", "questionnaires", "reloadDirt", "subagents", "threadGit", "threadState", "transcript", "threadIdentity", "transcriptIdentity"],
  safeAll: true,
  scope: "server:commands",
  sources: [
    "daemon/orchestrator/WorkbenchAgentCommandNode.ts",
    "daemon/orchestrator/WorkbenchAgentCommandController*.ts",
    "daemon/orchestrator/WorkbenchAgentCommandLogger*.ts",
    "daemon/orchestrator/CodexCommandExecController*.ts",
    "daemon/orchestrator/WorkbenchRipgrepController*.ts",
    "daemon/orchestrator/WorkbenchTokenCountController*.ts",
    "daemon/orchestrator/WorkbenchClaimStatsController*.ts",
    "daemon/lib/workbench/commands/**",
    "daemon/lib/workbench/cli/**",
    "daemon/lib/workbench/thread/WorkbenchThreadRecallController.ts",
  ].join("\n"),
});
