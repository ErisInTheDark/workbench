/*
 * Exports:
 * - default WorkbenchAgentCommandNode: own shared wb CLI and MCP command execution below core and above MCP adaptation, routing
 *   commands that reach other daemons through network grants, and executing calls other daemons relay here.
 */
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import { WorkbenchRequestUserInputCommandSchema } from "../lib/workbench/commands/questionnaire-command-definition";
import { WorkbenchStoreCommandRequestSchema } from "../lib/workbench/commands/store-command-definitions";
import { WorkbenchTodoRequestSchema } from "../lib/workbench/commands/todo-command-definitions";
import { WorkbenchMcpRequestSchema, workbenchMcpFailure } from "../lib/workbench/commands/mcp-command-definitions";
import { isMcpToolRequestApproved, mcpToolRequestQuestions } from "workbench-shared/workbench/mcp/mcp-tool-request";
import { WorkbenchVisRequestSchema } from "../lib/workbench/commands/vis-command-definitions";
import { formatVisControls, formatVisSessionResult, parseVisProject } from "workbench-shared/workbench/vis/vis-contract";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import { isWorkbenchAgentMcpRuntimeReloadInterruption } from "../lib/workbench/commands/workbench-agent-command-definition";
import {
  WorkbenchHeapSnapshotRequestSchema, WorkbenchMcpSpyRequestSchema, WorkbenchSocketSpyRequestSchema, formatWorkbenchMcpSpy, formatWorkbenchSocketSpy,
} from "../lib/workbench/commands/debug-command-definitions";
import { writeDaemonHeapSnapshot } from "../runtime/daemon-heap-snapshot";
import WorkbenchThreadRecallController from "../lib/workbench/thread/WorkbenchThreadRecallController";
import ReloadableNode from "../runtime/ReloadableNode";
import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import WorkbenchAgentCommandLogger from "./WorkbenchAgentCommandLogger";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchTokenCountController from "./WorkbenchTokenCountController";
import WorkbenchClaimStatsController from "./WorkbenchClaimStatsController";
import WorkbenchToolStatsCommandController from "./WorkbenchToolStatsCommandController";
import WorkbenchFeedbackCommandController from "./WorkbenchFeedbackCommandController";
import WorkbenchProofOfWorkController from "./WorkbenchProofOfWorkController";
import { readWorkbenchProofOfWorkCatalogue } from "../lib/workbench/instructions/proof-of-work-catalogue";
import { projectWorkbenchTranscriptItems } from "workbench-shared/workbench/database/transcript/workbench-transcript-item-projection";
import WorkbenchFileRemovalController from "../project/WorkbenchFileRemovalController";
import WorkbenchTranscriptCommandController from "../transcript/WorkbenchTranscriptCommandController";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchHarness } from "workbench-shared/types";
import { ThreadReferenceSchema, TurnReferenceSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchProviderDispatcher from "../providers/WorkbenchProviderDispatcher";
import WorkbenchSkillController from "./WorkbenchSkillController";
import { WorkbenchSkillExecutionRequestSchema } from "../lib/workbench/commands/skill-command-definition";
import { listProjectSkillsFromRoot } from "../lib/workbench/project/project-agents-folder";
import { listActiveWorkbenchSkillDefinitions } from "../lib/workbench-library";
import WorkbenchServerSettings from "../lib/workbench/settings/WorkbenchServerSettings";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "../lib/workbench/commands/workbench-agent-command-definition";
import type { NetworkTarget } from "workbench-shared/workbench/network/network-grants";
import type { RelayRemoteSummary } from "workbench-shared/workbench/network/network-relay-contracts";
import type { RemoteCall } from "workbench-shared/workbench/network/network-remote-calls";
import type { NetworkCaller } from "../network/WorkbenchNetworkAccessController";
import WorkbenchRemoteCallController from "../network/WorkbenchRemoteCallController";
import { formatUntrustedRemoteOutput } from "../network/network-untrusted-output";
import { WorkbenchNetworkRequestSchema } from "../lib/workbench/commands/network-command-definitions";

const ThreadSummaryRequestSchema = z.object({ threadIds: z.array(z.string().trim().min(1)).min(1).max(64) }).passthrough();

/** One line per requested thread: sidebar facts, or why it was not found. Names come from other daemons, so they are marked as such. */
function formatRemoteSummaries(threadIds: readonly string[], summaries: Record<string, RelayRemoteSummary | null>) {
  return `${threadIds.map(threadId => {
    const located = summaries[threadId];
    if (!located) return `${threadId}  not found on any reachable daemon`;
    const row = located.summary.row;
    const status = row.lifecycle.settled ? `${row.lifecycle.kind}, settled` : row.lifecycle.kind;
    const kind = row.entryKind === "subagent" ? `subagent "${row.name}" of ${row.parentThreadId}` : "thread";
    return `${threadId}  ${status}  ${kind}  on ${located.hostname}  project ${located.projectId}  title (untrusted): ${JSON.stringify(row.title)}`;
  }).join("\n")}\n`;
}

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
    /** The calling thread and the cwd project it acts in. */
    const nativeTarget = async (threadId: string, cwd: string, harness?: string) => {
      const resolution = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench command", ownerThreadId: threadId });
      const identity = await harnesses.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId), projectId: resolution.project.id, ...(harness ? { harness: WorkbenchHarnessSchema.parse(harness) } : {}) });
      if (!identity?.bindings[0]) throw new Error("The managed thread has no native execution in this project.");
      return { identity, binding: identity.bindings[0], resolution };
    };
    const claimStats = new WorkbenchClaimStatsController({
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Claim statistics" }),
      read: async (request) => await stats.readClaims(request),
    });
    const toolStats = new WorkbenchToolStatsCommandController({
      resolveProject: async (cwd) => {
        const { project } = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Tool statistics" });
        // The catalogue owns display names, the same lookup feedback uses.
        return { id: project.id, name: projectCatalog.getCurrentSnapshot().data.find(({ id }) => id === project.id)?.name ?? project.id };
      },
      read: async (request) => await stats.readTools(request),
    });
    const feedback = new WorkbenchFeedbackCommandController({
      resolveCaller: async ({ cwd, harness, threadId }, signal) => {
        const { identity, binding, resolution: { project } } = await nativeTarget(threadId, cwd, harness);
        signal.throwIfAborted();
        const callerHarness = WorkbenchHarnessSchema.parse(binding.harness);
        const profile = await threadState.controller.readComposerProfileTarget({
          harness: callerHarness, kind: "thread", projectId: project.id, threadId: identity.threadId,
        });
        return {
          harness: callerHarness,
          model: profile?.settings.model ?? null,
          projectId: project.id,
          reasoningEffort: profile?.settings.reasoningEffort ?? null,
          threadId: identity.threadId,
        };
      },
      resolveProjectId: async (cwd) => (await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Feedback statistics" })).project.id,
      projectName: (projectId) => projectCatalog.getCurrentSnapshot().data.find(({ id }) => id === projectId)?.name ?? null,
      record: async (entry) => await stats.recordFeedback(entry),
      read: async (request) => await stats.readFeedback(request),
    });
    const questionnaires = build.get("questionnaires");
    const network = build.get("network");
    const plainText = (text: string, status = 200) => new Response(text, {
      status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
    /** The local managed thread behind an outbound networked command. */
    const networkCaller = async (threadId: string, cwd: string): Promise<NetworkCaller> => {
      const { project } = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Agent networking", ownerThreadId: threadId });
      const identity = await harnesses.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId), projectId: project.id });
      if (!identity) throw new Error("The managed thread has no admitted identity in this project.");
      const entry = await threadState.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
      return { threadId: identity.threadId, cwd, projectId: project.id, title: entry && entry.entryKind !== "draft" ? entry.title : "agent" };
    };
    type RemoteThread = Extract<NetworkTarget, { kind: "thread" }>;
    /** A thread this daemon has recorded; relayed callers reach only these, never ids a provider would admit on request. */
    const heldThread = async (threadId: string) =>
      await harnesses.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId) }, { allowProviderAdmission: false });
    /**
     * Where a thread an agent names lives: this daemon's own records first, then another daemon a connected app finds it
     * on, and only then a provider thread this daemon has not recorded yet.
     */
    const locateThread = async (threadId: string, signal: AbortSignal) => {
      const held = await heldThread(threadId);
      if (held) return { kind: "local" as const, identity: held };
      let remoteFailure: unknown;
      try {
        const target = await network.access.resolveOne({ kind: "thread", threadId }, signal);
        if (target.kind === "thread") return { kind: "remote" as const, target };
      } catch (error) { remoteFailure = error; }
      try {
        const admitted = await harnesses.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId) });
        if (admitted) return { kind: "local" as const, identity: admitted };
        throw new Error("no provider holds it");
      } catch (localFailure) {
        const reason = (error: unknown) => error instanceof Error ? error.message : String(error ?? "not found");
        throw new Error(`Thread ${threadId} is not here (${reason(localFailure)}) nor on another daemon (${reason(remoteFailure)}).`);
      }
    };
    /** Reads a thread another daemon holds, through that daemon's grant; its answer reaches the agent marked untrusted. */
    const remoteThreadCall = async (caller: NetworkCaller, target: RemoteThread, verb: string,
      call: (target: RemoteThread) => RemoteCall, signal: AbortSignal) => {
      const outcome = await network.access.call(caller, {
        daemonId: target.daemonId, target: async () => target, call: call(target),
        reason: `"${caller.title}" wants to ${verb} "${target.title}" (${target.projectName}) on ${target.hostname}.`,
      }, signal);
      return formatUntrustedRemoteOutput({ hostname: target.hostname, source: `thread ${target.threadId}` }, outcome.text ?? "");
    };
    const messages = build.get("messages");
    const subagents = build.get("subagents");
    const subagentQueues = build.get("subagentQueues");
    const threadState = build.get("threadState");
    const settings = new WorkbenchServerSettings(database);
    const skill = new WorkbenchSkillController({
      listSkills: async root => await listActiveWorkbenchSkillDefinitions(await listProjectSkillsFromRoot(root)),
      readInstructionTools: () => build.run("mcp", mcp => mcp.listInstructionTools(), "Skill instruction tool catalogue"),
      readLocalCapabilities: () => settings.readLocalCapabilities(),
      onLoaded: ({ threadId, path }) => build.get("threadSkills").recordActivations(threadId, [path], "agent"),
    });
    const transcript = build.get("transcript");
    const reloadDirt = build.get("reloadDirt");
    const resolveSkillRequest = async (request: { cwd: string; harness: WorkbenchHarness; name: string; threadId: string }) => {
      const { identity, resolution: resolved } = await nativeTarget(request.threadId, request.cwd, request.harness);
      const profile = await threadState.controller.readComposerProfileTarget({
        harness: request.harness,
        kind: "thread",
        projectId: resolved.project.id,
        threadId: identity.threadId,
      });
      return {
        cwd: resolved.root.rootPath,
        harness: request.harness,
        model: profile?.settings.model ?? "",
        name: request.name,
        threadId: identity.threadId,
      };
    };
    const tokens = new WorkbenchTokenCountController({
      projectRoot: context.legacyMigrationProjectRoot,
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, {
        endpointName: "Project token counting",
      }),
      renderSkill: async (request, signal) => await skill.render(await resolveSkillRequest(request), signal),
    });
    const fileRemoval = new WorkbenchFileRemovalController(async ({ cwd, harness, threadId, paths }, signal) => {
      const { identity, binding } = await nativeTarget(threadId, cwd, harness);
      signal.throwIfAborted();
      return await gitArc.checkActiveClaimPaths(cwd, WorkbenchHarnessSchema.parse(binding.harness), identity.threadId, paths);
    });
    const proofOfWork = new WorkbenchProofOfWorkController({
      resolveCaller: async ({ cwd, harness, threadId }, signal) => {
        const { identity, resolution: { root } } = await nativeTarget(threadId, cwd, harness);
        signal.throwIfAborted();
        return { threadId: identity.threadId, projectRoot: root.rootPath };
      },
      readCatalogue: async projectRoot => await readWorkbenchProofOfWorkCatalogue(projectRoot),
      readTurnItems: async (threadId, signal) => {
        const snapshot = await transcript.read({ threadId, turnLimit: 1 });
        signal.throwIfAborted();
        if (!snapshot) return [];
        const projection = projectWorkbenchTranscriptItems(snapshot.rows);
        if (!projection.success) throw new Error("The current turn's transcript could not be read.");
        return projection.data
          .sort((left, right) => left.root.item_position - right.root.item_position)
          .flatMap(({ item }) => item.type === "mcpToolCall" ? [item] : []);
      },
    });
    const commandLogger = new WorkbenchAgentCommandLogger();
    const materializeTurn = async (threadId: string, turnId: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      const identity = await harnesses.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(threadId) });
      const turn = turnId && identity ? await threadIdentity.resolveTurn({ threadId: identity.threadId, turnId: TurnReferenceSchema.parse(turnId) }) : null;
      const binding = turn?.native ?? identity?.bindings[0];
      if (!identity || !binding || (turnId && !turn)) throw new Error("No matching provider execution.");
      await provider(binding.harness).threads.history.materialize(identity.threadId, turn?.turnId ?? null, signal);
      signal.throwIfAborted();
    };
    const transcriptCommands = new WorkbenchTranscriptCommandController({
      materializeTurn: async (threadId, turnId, signal) => await materializeTurn(threadId, turnId, signal),
      projectRoot: context.legacyMigrationProjectRoot,
      read: async (query) => await database.queryHistory(query),
    });
    const threadRecall = new WorkbenchThreadRecallController({
      materializeTurn,
      queryHistory: async (query) => await database.queryHistory(query),
      readThread: async (threadId) => {
        const thread = (await transcript.read({ threadId, turnIds: [], turnLimit: 1 }))?.thread;
        return thread ? { id: thread.id, projectRoot: thread.project_root } : null;
      },
      resolveProjectFromCwd: async (cwd) => {
        await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, {
          endpointName: "Thread Recall",
        });
      },
    });
    const agentCommand = new WorkbenchAgentCommandController(context.localDaemonOrigin, {
      executeMessageWaitRequest: async (body, signal, lifetimeSignal) => {
        const outcome = await messages.wait(body, signal, lifetimeSignal);
        const text = outcome.kind === "message"
          ? `Agent message from ${outcome.message.senderName} (${outcome.message.senderThreadId})\n\n${outcome.message.message}\n`
          : "Wait interrupted: a new message arrived for this thread. Read it, then call this tool again if you still need to wait.\n";
        return new Response(text, {
          headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        });
      },
      executeSubagentQueueRequest: async (body, signal) => {
        try {
          // A child whose parent lives on another daemon joins the parent's queues there.
          const request = body as { callerThreadId?: unknown; cwd?: unknown };
          if (typeof request.callerThreadId === "string" && typeof request.cwd === "string") {
            const caller = await networkCaller(request.callerThreadId, request.cwd);
            const relationship = (await subagents.listRelationships(caller.projectId)).subagents.find(record => record.threadId === caller.threadId);
            if (relationship?.parent) {
              const outcome = await network.family({ threadId: caller.threadId, title: caller.title }, relationship.parent.daemonId,
                { kind: "queue", parentThreadId: relationship.parentThreadId, body: body as Record<string, JsonValue> }, signal);
              return plainText(outcome.text ?? "");
            }
          }
          return new Response(await subagentQueues.execute(body, signal), {
            headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
          });
        } catch (error) {
          // Aborts and reload interruptions must propagate so long waits re-enter or cancel.
          if (signal.aborted || isWorkbenchAgentMcpRuntimeReloadInterruption(error)) throw error;
          return Response.json({ error: error instanceof Error ? error.message : "Workbench subagent queue request failed." }, { status: 400 });
        }
      },
      patchClaims: async (harness, input, signal) => {
        const tools = provider(harness).tools;
        if (!tools) throw new Error(`Provider ${harness} has no Workbench tools.`);
        return await tools.patchClaims(
          input, ({ cwd, harness, paths, threadId }) => gitArc.checkActiveClaimPaths(cwd, harness, threadId, paths), signal,
        );
      },
      executeBrowseRequest: context.executeBrowseRequest,
      executeGitArcRequest: async (body, signal) => await gitArc.executeRequest(body, signal),
      executeQuestionnaireRequest: async (body, signal) => {
        const request = WorkbenchRequestUserInputCommandSchema.parse(body);
        const { identity } = await nativeTarget(request.callerThreadId, request.cwd);
        return Response.json(await questionnaires.request({ ...request, callerThreadId: identity.threadId }, signal));
      },
      executeThreadGitRequest: async (body, signal) => {
        signal.throwIfAborted();
        return await build.get("threadGit").executeRequest(body, {
          signal,
          // Connected apps reach peer daemons; this daemon only asks one of them through the relay.
          fetchPeer: async (question, fetchSignal) => {
            const outcome = await network.relay.request({ kind: "gitPeerFetch", question }, fetchSignal);
            if (outcome.kind === "failed") throw new Error(outcome.failure);
            return outcome;
          },
        });
      },
      executeThreadRecallRequest: async (request, signal) => {
        const url = new URL(request.path, context.localDaemonOrigin);
        const prefix = "/api/thread-context/";
        if (!url.pathname.startsWith(prefix)) throw new Error("Invalid Thread Recall command path.");
        signal.throwIfAborted();
        const callerId = url.searchParams.get("caller");
        const callerCwd = url.searchParams.get("cwd");
        const searchParams = new URLSearchParams(url.searchParams);
        searchParams.delete("caller");
        searchParams.delete("cwd");
        const targetId = decodeURIComponent(url.pathname.slice(prefix.length));
        const located = await locateThread(targetId, signal);
        if (located.kind === "remote") {
          // Another daemon's thread, reached only through that daemon's grant.
          if (!callerId || !callerCwd) throw new Error("Thread Recall of another daemon's thread needs its calling thread.");
          const caller = await networkCaller(callerId, callerCwd);
          return plainText(await remoteThreadCall(caller, located.target, "read the history of", target => ({
            kind: "recall", threadId: target.threadId, search: request.method === "POST", query: searchParams.toString(),
            body: request.method === "POST" && request.body ? JSON.stringify(request.body) : null,
          }), signal));
        }
        signal.throwIfAborted();
        return await threadRecall.execute({
          body: request.body,
          method: request.method,
          searchParams,
          threadId: located.identity.threadId,
        }, signal);
      },
      executeNetworkRequest: async (body, signal) => {
        const request = WorkbenchNetworkRequestSchema.parse(body);
        const caller = await networkCaller(request.threadId, request.cwd);
        return plainText(await network.access.request(caller, [
          ...request.threads.map(threadId => ({ kind: "thread" as const, threadId })),
          ...request.folders.map(address => ({ kind: "folder" as const, address, callerProjectId: caller.projectId })),
          ...request.feedback.map(address => ({ kind: "feedback" as const, address, callerProjectId: caller.projectId })),
        ], request.reason, signal));
      },
      executeThreadSummary: async (body, signal) => {
        const request = conformToZodSchema(ThreadSummaryRequestSchema.nullable(), body, null).data;
        if (!request) return plainText("Invalid thread summary arguments.\n", 400);
        const { summaries } = await network.relay.request({ kind: "summary", threadIds: request.threadIds }, signal);
        return plainText(formatRemoteSummaries(request.threadIds, summaries));
      },
      executeTokenCount: async (body, signal) => await tokens.execute(body, signal),
      executeTranscriptQuery: async (body, signal) => {
        const request = body as { threads?: unknown; callerThreadId?: unknown; cwd?: unknown; action?: unknown };
        const threads = Array.isArray(request.threads) ? request.threads.filter((id): id is string => typeof id === "string") : [];
        const located = await Promise.all(threads.map(id => locateThread(id, signal)));
        const remote = located.flatMap(entry => entry.kind === "remote" ? [entry.target] : []);
        if (!remote.length) return await transcriptCommands.execute(body, signal);
        // Threads held elsewhere are read on their own daemon, one thread per request so each needs its own grant.
        if (threads.length !== 1 || typeof request.callerThreadId !== "string" || typeof request.cwd !== "string") {
          return plainText("Read one thread from another daemon per transcript command, and do not mix it with local threads.\n", 400);
        }
        const normalized = (value: string) => {
          const resolved = path.resolve(value);
          return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        };
        if (normalized(request.cwd) !== normalized(context.legacyMigrationProjectRoot)) {
          return plainText("Managed threads can query transcripts only from the running Workbench repository root.\n", 403);
        }
        const caller = await networkCaller(request.callerThreadId, request.cwd);
        const { cwd: _cwd, callerThreadId: _caller, provider: _provider, ...query } = body as Record<string, JsonValue>;
        return plainText(await remoteThreadCall(caller, remote[0]!, "read the transcript of", target => ({
          kind: "transcript", threadIds: [target.threadId], body: query,
        }), signal));
      },
      executeSocketSpy: async (body, signal) => {
        const request = WorkbenchSocketSpyRequestSchema.parse(body);
        const answer = await build.run("webSocketRequests", controller => controller.spy(request.query, request.target, signal), "socket spy");
        return new Response(formatWorkbenchSocketSpy(answer), {
          headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
        });
      },
      executeMcpSpy: async body => new Response(formatWorkbenchMcpSpy(build.get("mcpServers").traffic(WorkbenchMcpSpyRequestSchema.parse(body).query)), {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      }),
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
      executeToolStats: async (body, signal) => await toolStats.execute(body, signal),
      executeFeedbackSubmit: async (body, signal) => await feedback.submit(body, signal),
      executeProofOfWorkRequest: async (body, signal) => await proofOfWork.execute(body, signal),
      executeTodoRequest: async (body, signal) => {
        const parsed = WorkbenchTodoRequestSchema.safeParse(body);
        if (!parsed.success) {
          const detail = parsed.error.issues.slice(0, 5).map(({ message, path }) => `${path.map(String).join(".") || "input"}: ${message}`).join("\n");
          return new Response(`Invalid todo arguments.\n${detail}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" }, status: 400 });
        }
        const request = parsed.data;
        const { identity } = await nativeTarget(request.threadId, request.cwd, request.harness);
        signal.throwIfAborted();
        const todos = build.get("threadTodos");
        const text = request.action === "list" ? await todos.renderList(identity.threadId)
          : request.action === "add" ? await todos.renderAdd(identity.threadId, request.text, request.required)
            : await todos.renderRemove(identity.threadId, request.ids);
        return new Response(text, { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
      },
      executeMcpRequest: async (body, signal) => {
        const headers = { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" };
        const parsed = WorkbenchMcpRequestSchema.safeParse(body);
        if (!parsed.success) return workbenchMcpFailure("Invalid mcp arguments.\n", 400);
        const request = parsed.data;
        const mcpServers = build.get("mcpServers");
        /** The managed thread behind the request and the project it works in, which decides the project servers it sees. */
        const resolveCaller = async (target: { threadId: string; cwd: string; harness: string }) => {
          const { identity, resolution: { project } } = await nativeTarget(target.threadId, target.cwd, target.harness);
          return { identity, mcp: { threadId: identity.threadId, cwd: target.cwd, projectId: project.id } };
        };
        /** Unmanaged callers have no thread and see global servers only. */
        const optionalCaller = async () => request.threadId && request.cwd && request.harness
          ? (await resolveCaller({ threadId: request.threadId, cwd: request.cwd, harness: request.harness })).mcp : null;
        try {
          if (request.action === "tools") return new Response(await mcpServers.listTools(request, await optionalCaller(), signal), { headers });
          if (request.action === "reload") return new Response(await mcpServers.reload(request, await optionalCaller()), { headers });
          if (request.action === "connect") {
            const resolved = await resolveCaller(request);
            const text = await mcpServers.connectThreadServer({ name: request.server, url: request.url }, resolved.mcp,
              async mcpConnection => isMcpToolRequestApproved(await questionnaires.request({
                callerThreadId: resolved.identity.threadId, cwd: request.cwd, requestKey: request.requestKey, mcpConnection,
                questions: mcpToolRequestQuestions(request.reason, "connect"),
              }, signal)), signal);
            return new Response(text, { headers });
          }
          if (request.action === "request") {
            const resolved = await resolveCaller(request);
            const { identity } = resolved;
            const text = await mcpServers.requestTool(request, resolved.mcp, async mcpTool => {
              const response = await questionnaires.request({
                callerThreadId: identity.threadId, cwd: request.cwd, requestKey: request.requestKey, mcpTool,
                questions: mcpToolRequestQuestions(request.reason),
              }, signal);
              return isMcpToolRequestApproved(response);
            }, signal);
            return new Response(text, { headers });
          }
          if (request.action === "download") {
            const resolved = await resolveCaller(request);
            return new Response(await mcpServers.downloadLink({ ...request, threadId: resolved.identity.threadId }, resolved.mcp, signal), { headers });
          }
          if (request.action === "authorize") {
            const resolved = await resolveCaller(request);
            const { identity } = resolved;
            const text = await mcpServers.authorizeLink(request, resolved.mcp, async mcpAuthorization => isMcpToolRequestApproved(await questionnaires.request({
              callerThreadId: identity.threadId, cwd: request.cwd, requestKey: request.requestKey, mcpAuthorization,
              questions: mcpToolRequestQuestions(request.reason, "authorize"),
            }, signal)));
            return new Response(text, { headers });
          }
          const outcome = await mcpServers.call(request, await optionalCaller(), signal);
          return outcome.isError ? workbenchMcpFailure(outcome.text, 422) : new Response(outcome.text, { headers });
        } catch (error) {
          if (signal.aborted) throw error;
          return workbenchMcpFailure(`${error instanceof Error ? error.message : "MCP request failed."}\n`, 400);
        }
      },
      executeVisRequest: async (body, signal) => {
        const parsed = conformToZodSchema(WorkbenchVisRequestSchema, body);
        if (!parsed.success) return new Response("Invalid vis arguments.\n", { headers: { "Content-Type": "text/plain; charset=utf-8" }, status: 400 });
        const request = parsed.data;
        const { identity, binding, resolution: { project, root } } = await nativeTarget(request.threadId, request.cwd, request.harness);
        signal.throwIfAborted();
        const vis = build.get("vis");
        const text = (kind: "start" | "end", result: { sessionId: string; path: string; failure: string | null }) =>
          `${formatVisSessionResult(kind, result.sessionId, result.path)}${result.failure ? `\nRendered with a problem: ${result.failure}` : ""}\n`;
        try {
          const body = request.action === "test"
            ? await vis.testMarkup({ threadId: identity.threadId, cwd: request.cwd, markup: request.markup }, signal)
            : request.action === "match"
            ? await vis.testMatcher({ threadId: identity.threadId, cwd: request.cwd, call: {
              server: request.server, tool: request.tool, arguments: request.arguments ?? {}, keep: request.keep ?? null,
              status: request.status ?? "completed", error: request.error ?? null, result: request.result ?? null,
            } }, signal)
            : request.action === "start"
            ? text("start", await vis.startSession({
              threadId: identity.threadId, harness: binding.harness, cwd: request.cwd, projectId: project.id, rootPath: root.rootPath,
              path: request.path, project: parseVisProject(request.project),
            }))
            : request.action === "end"
              ? text("end", await vis.endSession({ threadId: identity.threadId, cwd: request.cwd, rootPath: root.rootPath, path: request.path }))
              : request.action === "read"
                ? formatVisControls(await vis.readControls({ threadId: identity.threadId, cwd: request.cwd, rootPath: root.rootPath, path: request.path }))
                : await vis.inspect({ threadId: identity.threadId, cwd: request.cwd, rootPath: root.rootPath, path: request.path }, request.action);
          return new Response(body, { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
        } catch (error) {
          if (signal.aborted) throw error;
          return Response.json({ error: error instanceof Error ? error.message : "Vis request failed." }, { status: 400 });
        }
      },
      acceptVisRender: (runId, content) => build.get("vis").acceptRender(runId, content),
      executeFeedbackStats: async (body, signal) => {
        const request = body as { host?: unknown; callerThreadId?: unknown; cwd?: unknown };
        if (typeof request.host !== "string" || !request.host) return await feedback.read(body, signal);
        if (typeof request.callerThreadId !== "string" || typeof request.cwd !== "string") {
          return plainText("Reading another daemon's feedback needs a managed thread.\n", 400);
        }
        const caller = await networkCaller(request.callerThreadId, request.cwd);
        const target = await network.access.resolveOne({ kind: "feedback", address: request.host, callerProjectId: caller.projectId }, signal);
        if (target.kind !== "feedback") throw new Error(`${request.host} is not a feedback source.`);
        const { host: _host, callerThreadId: _caller, cwd: _cwd, ...query } = body as Record<string, JsonValue>;
        const outcome = await network.access.call(caller, {
          daemonId: target.daemonId, target: async () => target,
          reason: `"${caller.title}" wants to read ${target.rootPath ? `feedback for ${target.rootPath}` : "wb feedback"} on ${target.hostname}.`,
          call: { kind: "feedbackStats", projectId: target.projectId, body: query },
        }, signal);
        return plainText(formatUntrustedRemoteOutput({ hostname: target.hostname, source: "feedback" }, outcome.text ?? ""));
      },
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
      readLocalCapabilities: () => settings.readLocalCapabilities(),
      hydrateRepoPath: async (absolutePath, signal) => await repo.hydrate(absolutePath, signal),
      executeSkillRequest: async (body, signal) => {
        const request = WorkbenchSkillExecutionRequestSchema.parse(body);
        return await skill.execute(await resolveSkillRequest(request), signal);
      },
      executeSessionRequest: context.executeBrowseSessionRequest,
      getReloadScopeCatalog: () => reloadDirt.getCatalog(),
      resolveCaller: async (threadId, cwd, harness) => {
        const { identity, binding } = await nativeTarget(threadId, cwd, harness);
        const entry = await threadState.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
        return {
          threadId: identity.threadId,
          nativeThreadId: binding.nativeThreadId,
          harness: WorkbenchHarnessSchema.parse(binding.harness),
          subagent: entry?.entryKind === "subagent",
        };
      },
      readReloadDirtSnapshot: () => reloadDirt.getSnapshot(),
      requestManagedThread: async (request, signal) => request.method?.startsWith("workbench/thread/")
        ? await threadState.handleManagedThreadRequest(request)
        : request.method === "workbench/message"
          ? await messages.send(request.params).then(
            () => ({ id: request.id ?? null, result: {} }),
            error => ({ id: request.id ?? null, error: { code: -32000, message: error instanceof Error ? error.message : "Workbench message failed." } }),
          )
          : await subagents.handleRequest(request, signal),
      workbenchProjectRoot: context.legacyMigrationProjectRoot,
    }, undefined, undefined, commandLogger);
    // Calls other daemons' threads relay here run only after this daemon authorizes them; none of these ports can relay onward.
    const remoteCalls = new WorkbenchRemoteCallController({
      selfDaemonId: () => network.relay.self()?.daemonId ?? null,
      grants: caller => database.readNetworkGrantsForCaller({ daemonId: caller.daemonId, threadId: caller.threadId }),
      thread: async threadId => {
        const identity = await heldThread(threadId);
        if (!identity) return null;
        const entry = await threadState.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
        return { threadId: identity.threadId, parent: entry?.entryKind === "subagent"
          ? { threadId: entry.parentThreadId, daemonId: entry.parentDaemonId ?? null } : null };
      },
      roster: threadId => subagents.readRoster(threadId),
      isRemoteChild: async (parentThreadId, caller) => (await subagents.remote.parentsOf(caller)).includes(parentThreadId),
      remoteParentsOf: caller => subagents.remote.parentsOf(caller),
      recall: async (call, signal) => await (await threadRecall.execute({
        body: call.body === null ? undefined : JSON.parse(call.body) as unknown, method: call.search ? "POST" : "GET",
        searchParams: new URLSearchParams(call.query), threadId: call.threadId,
      }, signal)).text(),
      transcript: async (body, signal) => await (await transcriptCommands.execute({
        ...body, cwd: context.legacyMigrationProjectRoot, callerThreadId: null, provider: undefined,
      }, signal)).text(),
      feedbackStats: async (projectId, body, signal) => await (await feedback.readRemote(projectId, body, signal)).text(),
      message: (caller, call) => messages.admitRemote(caller, call),
      subagentProfiles: projectId => subagents.remote.profilesFor(projectId),
      subagentCreate: (caller, call) => subagents.remote.createForRemoteParent(caller, call),
      childRead: threadIds => subagents.remote.readChildren(threadIds),
      childStop: threadIds => subagents.remote.stopChildren(threadIds),
      childSettle: threadId => subagents.remote.settleChild(threadId),
      writeRoster: (threadId, siblings) => subagents.remote.writeRoster(threadId, siblings),
      childChanged: parentThreadIds => subagents.remote.childChanged(parentThreadIds),
      queue: async (caller, parentThreadId, body, signal) => {
        const parent = await heldThread(parentThreadId);
        const record = parent ? await subagents.getOwned(parent.threadId, parent.projectId, caller.threadId) : null;
        if (!record) throw new Error("You are not a subagent of that thread.");
        return await subagentQueues.executeRemoteMember({ threadId: record.threadId, name: record.name, parentThreadId: record.parentThreadId,
          projectId: record.projectId }, body, signal);
      },
      release: caller => database.revokeNetworkGrants({ callerDaemonId: caller.daemonId, callerThreadId: caller.threadId }),
    });
    const unregisterNetwork = build.get("daemonRequests").registerNetwork({
      execute: (params, signal) => remoteCalls.execute(params, signal),
      createGrant: grant => database.createNetworkGrant({ id: randomUUID(), createdAt: Date.now(), grant }),
      listGrants: () => database.listNetworkGrants(),
      revokeGrants: revoke => database.revokeNetworkGrants(revoke),
      revokeHistory: async (threadId, entryId) => (await network.revokeHistory(WorkbenchThreadIdSchema.parse(threadId), entryId))
        .some(entry => entry.id === entryId && entry.revokedAt !== null),
    });
    return {
      beginRuntimeDrain: () => { agentCommand.beginRuntimeDrain(); },
      dispose: async () => {
        unregisterNetwork();
        await agentCommand.dispose();
      },
      listRuntimeDrainPending: () => agentCommand.listRuntimeDrainPending(),
      registrations: { agentCommand },
      start: () => undefined,
    };
  },
  description: "Reload shared wb CLI and MCP command execution without replacing core state.",
  lifecycle: "atomic",
  provides: ["agentCommand"],
  requires: ["daemonRequests", "database", "gitArc", "harnesses", "mcpServers", "messages", "network", "repo", "projectCatalog", "projectStore", "questionnaires", "reloadDirt", "stats", "subagents", "subagentQueues", "threadGit", "threadSkills", "threadState", "threadTodos", "transcript", "threadIdentity", "vis"],
  safeAll: true,
  scope: "server:commands",
});
