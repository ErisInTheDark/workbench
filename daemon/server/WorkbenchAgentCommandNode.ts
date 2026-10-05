/*
 * Exports:
 * - default WorkbenchAgentCommandNode: own shared wb CLI and MCP command execution below core and above MCP adaptation.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { WorkbenchRequestUserInputCommandSchema } from "./lib/workbench/commands/questionnaire-command-definition";
import { WorkbenchStoreCommandRequestSchema } from "./lib/workbench/commands/store-command-definitions";
import {
  WorkbenchHeapSnapshotRequestSchema, WorkbenchSocketSpyRequestSchema, formatWorkbenchSocketSpy,
} from "./lib/workbench/commands/debug-command-definitions";
import { writeDaemonHeapSnapshot } from "./daemon-heap-snapshot";
import WorkbenchThreadRecallController from "./lib/workbench/thread/WorkbenchThreadRecallController";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import WorkbenchAgentCommandLogger from "./WorkbenchAgentCommandLogger";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchTokenCountController from "./WorkbenchTokenCountController";
import WorkbenchClaimStatsController from "./WorkbenchClaimStatsController";
import WorkbenchFileRemovalController from "./WorkbenchFileRemovalController";
import WorkbenchTranscriptCommandController from "./WorkbenchTranscriptCommandController";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { ThreadReferenceSchema, TurnReferenceSchema, ItemReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import WorkbenchSkillController from "./WorkbenchSkillController";
import { WorkbenchSkillExecutionRequestSchema } from "./lib/workbench/commands/skill-command-definition";
import { listProjectSkillDefinitionsFromRoot } from "./lib/project";
import { listActiveWorkbenchSkillDefinitions } from "./lib/workbench-library";
import WorkbenchServerSettings from "./lib/workbench/settings/WorkbenchServerSettings";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [WorkbenchMcpNode],
  create: (context, build) => {
    const gitArc = build.get("gitArc");
    const repo = build.get("repo");
    const harnesses = build.get("harnesses");
    const providers = new WorkbenchProviderDispatcher(build.run);
    const provider = (harness: string) => {
      const key = installedProviderKeys.find(key => key === harness);
      if (!key) throw new Error(`Provider ${harness} is not installed.`);
      return providers.get(key);
    };
    const projectCatalog = build.get("projectCatalog");
    const database = build.get("database");
    const projectStore = build.get("projectStore");
    const stats = build.get("stats");
    const threadIdentity = build.get("threadIdentity");
    const transcriptIdentity = build.get("transcriptIdentity");
    const nativeTarget = async (threadId: string, cwd: string, harness?: string) => {
      const project = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench command" });
      const identity = await harnesses.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId), projectId: project.project.id, ...(harness ? { harness: WorkbenchHarnessSchema.parse(harness) } : {}) });
      if (!identity?.bindings[0]) throw new Error("The managed thread has no native execution in this project.");
      return { identity, binding: identity.bindings[0] };
    };
    const claimStats = new WorkbenchClaimStatsController({
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Claim statistics" }),
      read: async (request) => await stats.readClaims(request),
    });
    const transcriptCommands = new WorkbenchTranscriptCommandController({
      projectRoot: context.legacyMigrationProjectRoot,
      read: async (query) => await database.queryTranscript(query),
    });
    const questionnaires = build.get("questionnaires");
    const messages = build.get("messages");
    const subagents = build.get("subagents");
    const threadState = build.get("threadState");
    const settings = new WorkbenchServerSettings(database);
    const skill = new WorkbenchSkillController({
      listSkills: async root => await listActiveWorkbenchSkillDefinitions(await listProjectSkillDefinitionsFromRoot(root)),
      readInstructionTools: () => build.run("mcp", mcp => mcp.listInstructionTools(), "Skill instruction tool catalogue"),
      readLocalCapabilities: () => settings.readLocalCapabilities(),
      onLoaded: ({ threadId, path }) => build.get("threadSkills").recordActivations(threadId, [path], "agent"),
    });
    const transcript = build.get("transcript");
    const reloadDirt = build.get("reloadDirt");
    const tokens = new WorkbenchTokenCountController({
      projectRoot: context.legacyMigrationProjectRoot,
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, {
        endpointName: "Project token counting",
      }),
    });
    const fileRemoval = new WorkbenchFileRemovalController(async ({ cwd, harness, threadId, paths }, signal) => {
      const { identity, binding } = await nativeTarget(threadId, cwd, harness);
      signal.throwIfAborted();
      return await gitArc.checkActiveClaimPaths(cwd, WorkbenchHarnessSchema.parse(binding.harness), identity.threadId, paths);
    });
    const commandLogger = new WorkbenchAgentCommandLogger();
    const materializeTurn = async (threadId: string, turnId: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      const identity = await harnesses.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId) });
      const turn = turnId && identity ? await threadIdentity.resolveTurn({ threadId: identity.threadId, turnId: TurnReferenceSchema.parse(turnId) }) : null;
      const binding = turn?.native ?? identity?.bindings[0];
      if (!identity || !binding || (turnId && !turn)) throw new Error("Thread Recall has no matching provider execution.");
      await provider(binding.harness).threads.history.materialize(identity.threadId, turn?.turnId ?? null, signal);
      signal.throwIfAborted();
    };
    const threadRecall = new WorkbenchThreadRecallController({
      materializeTurn,
      readTranscript: async (request) => await transcript.read(request),
      resolveReference: async (threadId, locator, signal) => {
        const identity = threadIdentity.knownThread(ThreadReferenceSchema.parse(threadId));
        const turn = await threadIdentity.resolveTurn({ threadId: identity.threadId, turnId: TurnReferenceSchema.parse(locator.turnId) });
        if (!turn) throw new Error("Thread Recall cursor has no matching turn.");
        const snapshot = await transcript.read({ threadId, turnIds: [turn.turnId], turnLimit: 1 });
        if (!snapshot) {
          await materializeTurn(threadId, turn.turnId, signal);
          await transcript.read({ threadId, turnIds: [turn.turnId], turnLimit: 1 });
        }
        signal.throwIfAborted();
        const item = await transcriptIdentity.resolve({ threadId: identity.threadId, turnId: turn.turnId, itemId: ItemReferenceSchema.parse(locator.itemId) });
        if (!item) throw new Error("Thread Recall cursor has no matching item.");
        return { ...locator, turnId: turn.turnId, itemId: item.itemId };
      },
      resolveProjectFromCwd: async (cwd) => {
        await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, {
          endpointName: "Thread Recall",
        });
      },
    });
    const agentCommand = new WorkbenchAgentCommandController(context.localDaemonOrigin, {
      executeMessageWaitRequest: async (body, signal, lifetimeSignal) => {
        const message = await messages.wait(body, signal, lifetimeSignal);
        return new Response(`Agent message from ${message.senderName} (${message.senderThreadId})\n\n${message.message}\n`, {
          headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        });
      },
      patchClaims: (harness, input, signal) => provider(harness).tools.patchClaims(
        input, ({ cwd, harness, paths, threadId }) => gitArc.checkActiveClaimPaths(cwd, harness, threadId, paths), signal,
      ),
      executeBrowseRequest: context.executeBrowseRequest,
      executeGitArcRequest: async (body, signal) => await gitArc.executeRequest(body, signal),
      executeQuestionnaireRequest: async (body, signal) => {
        const request = WorkbenchRequestUserInputCommandSchema.parse(body);
        const { identity } = await nativeTarget(request.callerThreadId, request.cwd);
        return Response.json(await questionnaires.request({ ...request, callerThreadId: identity.threadId }, signal));
      },
      executeThreadGitRequest: async (body, signal) => {
        signal.throwIfAborted();
        return await build.get("threadGit").executeRequest(body);
      },
      executeThreadRecallRequest: async (request, signal) => {
        const url = new URL(request.path, context.localDaemonOrigin);
        const prefix = "/api/thread-context/";
        if (!url.pathname.startsWith(prefix)) throw new Error("Invalid Thread Recall command path.");
        signal.throwIfAborted();
        const identity = await harnesses.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(decodeURIComponent(url.pathname.slice(prefix.length))) });
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
      executeTranscriptQuery: async (body, signal) => await transcriptCommands.execute(body, signal),
      executeSocketSpy: async (body, signal) => {
        const request = WorkbenchSocketSpyRequestSchema.parse(body);
        const answer = await build.run("webSocketRequests", controller => controller.spy(request.query, request.target, signal), "socket spy");
        return new Response(formatWorkbenchSocketSpy(answer), {
          headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        });
      },
      executeHeapSnapshot: async (body, signal) => {
        WorkbenchHeapSnapshotRequestSchema.parse(body);
        signal.throwIfAborted();
        const snapshot = await writeDaemonHeapSnapshot(context.dataRootPath);
        return new Response(
          `Wrote ${snapshot.path}\n${Math.round(snapshot.bytes / 1_048_576)}MB, daemon paused ${(snapshot.pauseMs / 1_000).toFixed(1)}s.\n`,
          { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } },
        );
      },
      executeClaimStats: async (body, signal) => await claimStats.execute(body, signal),
      executeFileRemoval: async (body, signal) => await fileRemoval.execute(body, signal),
      executeProjectStoreRequest: async (body, signal) => {
        const request = WorkbenchStoreCommandRequestSchema.parse(body);
        signal.throwIfAborted();
        if (request.action === "set") {
          await projectStore.setFromCwd(request.cwd, request.key, request.value);
          return new Response(`Saved ${request.key}.\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        const value = await projectStore.getFromCwd(request.cwd, request.key);
        return value === null
          ? Response.json({ error: `Store key ${request.key} is not set for this project.` }, { status: 404 })
          : new Response(`${value}\n`, { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
      },
      executeRepoWarm: async (body, signal) => await repo.warm(body, signal),
      virtualReposAvailable: () => repo.isAvailable(),
      hydrateRepoPath: async (absolutePath, signal) => await repo.hydrate(absolutePath, signal),
      executeSkillRequest: async (body, signal) => {
        const request = WorkbenchSkillExecutionRequestSchema.parse(body);
        const { identity } = await nativeTarget(request.threadId, request.cwd, request.harness);
        const resolved = await projectCatalog.resolveAgentEndpointProjectFromCwd(request.cwd, { endpointName: "Workbench skill" });
        const profile = await threadState.controller.readComposerProfileTarget({
          harness: request.harness,
          kind: "thread",
          projectId: resolved.project.id,
          threadId: identity.threadId,
        });
        return await skill.execute({
          cwd: resolved.root.rootPath,
          harness: request.harness,
          model: profile?.settings.model ?? "",
          name: request.name,
          threadId: identity.threadId,
        }, signal);
      },
      executeSessionRequest: context.executeBrowseSessionRequest,
      getReloadScopeCatalog: () => reloadDirt.getCatalog(),
      resolveCaller: async (threadId, cwd, harness) => {
        const { identity, binding } = await nativeTarget(threadId, cwd, harness);
        return { threadId: identity.threadId, nativeThreadId: binding.nativeThreadId, harness: WorkbenchHarnessSchema.parse(binding.harness) };
      },
      readReloadDirtSnapshot: () => reloadDirt.getSnapshot(),
      requestManagedThread: async (request) => request.method?.startsWith("workbench/thread/")
        ? await threadState.handleManagedThreadRequest(request)
        : request.method === "workbench/message" || request.method === "workbench/subagent/message"
          ? await messages.send(request.params).then(
            () => ({ id: request.id ?? null, result: {} }),
            error => ({ id: request.id ?? null, error: { code: -32000, message: error instanceof Error ? error.message : "Workbench message failed." } }),
          )
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
  requires: ["database", "gitArc", "harnesses", "messages", "repo", "projectCatalog", "projectStore", "questionnaires", "reloadDirt", "stats", "subagents", "threadGit", "threadSkills", "threadState", "transcript", "threadIdentity", "transcriptIdentity"],
  safeAll: true,
  scope: "server:commands",
});
