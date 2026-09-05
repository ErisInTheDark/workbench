/*
 * Exports:
 * - WorkbenchSubagentControllerOptions: injected bridge, durable store, harness client, and validated project resolver dependencies. Keywords: orchestrator, subagent, project, test.
 * - default WorkbenchSubagentController: own durable parent-child metadata, authorization, cross-harness lifecycle, and wait cancellation. Keywords: orchestrator, subagent, controller, ownership, wait.
 */
import { randomUUID } from "node:crypto";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import { CodexAppServerClient } from "workbench-shared/codex/app-server-client";
import { createQuestionnaireCollaborationMode, isCodexJsonRpcFailure } from "workbench-shared/codex/protocol";
import type {
  WorkbenchComposerProfile,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchSubagentRelationship,
  WorkbenchSubagentSummary,
} from "workbench-shared/types";
import {
  resolveAgentEndpointProjectFromCwd,
  type AgentEndpointProjectResolution,
} from "../lib/workbench/project/agent-endpoint-project";
import {
  createEmptySubagentQuestionnaireResponse,
  renderSubagentQuestionnaireOutput,
  renderSubagentTurnOutput,
  renderSubagentWaitResultOutput,
} from "../lib/workbench/subagent/subagent-output";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import { getWorkbenchThreadHarnessCandidates } from "workbench-shared/workbench/thread/thread-harness-candidates";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";

interface PendingQuestionnaireList {
  data: Array<Omit<WorkbenchPendingUserInputRequest, "harness">>;
}

interface SubagentRequestBase {
  callerThreadId: string;
  cwd: string;
  workbenchOrigin?: string;
}

interface ResolvedSubagentCaller {
  callerThreadId: string;
  cwd: string;
  project: AgentEndpointProjectResolution["project"];
}

const POLL_INTERVAL_MS = 1_000;
const PARENT_AGENT_NAME = "parent agent";
const WORKBENCH_PROMPT_CONTEXT_FIELD = "workbenchPromptContext";

type WorkbenchSubagentHarnessClient = Pick<CodexAppServerClient, "close" | "connect" | "sendRequest">;
type WorkbenchSubagentControllerStore = Pick<
  WorkbenchSubagentStore,
  "getOwned" | "getOwnedMany" | "list" | "remove" | "replace" | "reserve"
>;

export interface WorkbenchSubagentControllerOptions {
  bridgeUrl: string;
  createHarnessClient?: () => WorkbenchSubagentHarnessClient;
  onRelationshipCommitted(record: WorkbenchSubagentRelationship): Promise<void>;
  profileStore: Pick<WorkbenchComposerProfileStore, "read" | "mutate">;
  resolveProjectFromCwd?: typeof resolveAgentEndpointProjectFromCwd;
  subagentStore: WorkbenchSubagentControllerStore;
  threadState?: {
    getEntry(projectId: string, harness: WorkbenchHarness, threadId: string): Promise<WorkbenchThreadSidebarEntry | null>;
    mutate(request: WorkbenchThreadStateRequest): Promise<void>;
    subscribe(listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void): () => void;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string) {
  const value = typeof record[key] === "string" ? record[key].trim() : "";
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function requiredThreadIds(record: Record<string, unknown>) {
  const rawValues = Array.isArray(record.threadIds) ? record.threadIds : [record.threadId];
  const threadIds = rawValues.map((value) => typeof value === "string" ? value.trim() : "");
  if (!threadIds.length || threadIds.some((threadId) => !threadId)) throw new Error("threadIds are required.");
  if (new Set(threadIds).size !== threadIds.length) throw new Error("threadIds must be unique.");
  return threadIds;
}

function textInput(message: string): UserInput[] {
  return [{ text: message, text_elements: [], type: "text" }];
}

function agentMessageInput(message: string, senderName: string, senderThreadId: string) {
  return textInput(createWorkbenchAgentMessageText({ message, senderName, senderThreadId }));
}

function currentTurn(thread: Thread) {
  return thread.turns.at(-1) ?? null;
}

function isTurnActive(thread: Thread) {
  return currentTurn(thread)?.status === "inProgress";
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export default class WorkbenchSubagentController {
  private readonly bridgeUrl: string;
  private createQueue: Promise<void> = Promise.resolve();
  private readonly createHarnessClient: () => WorkbenchSubagentHarnessClient;
  private readonly onRelationshipCommitted: WorkbenchSubagentControllerOptions["onRelationshipCommitted"];
  private readonly profileStore: WorkbenchSubagentControllerOptions["profileStore"];
  private readonly resolveProjectFromCwd: typeof resolveAgentEndpointProjectFromCwd;
  private readonly subagentStore: WorkbenchSubagentControllerStore;
  private readonly threadState: WorkbenchSubagentControllerOptions["threadState"];
  private readonly waiters = new Map<string, AbortController>();

  constructor({
    bridgeUrl,
    createHarnessClient = () => new CodexAppServerClient(),
    onRelationshipCommitted,
    profileStore,
    resolveProjectFromCwd = resolveAgentEndpointProjectFromCwd,
    subagentStore,
    threadState,
  }: WorkbenchSubagentControllerOptions) {
    this.bridgeUrl = bridgeUrl;
    this.createHarnessClient = createHarnessClient;
    this.onRelationshipCommitted = onRelationshipCommitted;
    this.profileStore = profileStore;
    this.resolveProjectFromCwd = resolveProjectFromCwd;
    this.subagentStore = subagentStore;
    this.threadState = threadState;
  }

  beginRuntimeDrain() {
    for (const waiter of this.waiters.values()) waiter.abort(new Error("Subagent wait cancelled for runtime reload."));
    this.waiters.clear();
  }

  dispose() { this.beginRuntimeDrain(); }

  async handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = message.id ?? null;
    try {
      const params = isRecord(message.params) ? message.params : {};
      switch (message.method) {
        case "workbench/subagent/list": return { id, result: await this.list(params) };
        case "workbench/subagent/profiles": return { id, result: await this.profiles(params) };
        case "workbench/subagent/create": return { id, result: await this.withHarnessClient((client) => this.create(client, params)) };
        case "workbench/subagent/wait": return { id, result: await this.withHarnessClient((client) => this.wait(client, params)) };
        case "workbench/subagent/waitCancel": return { id, result: this.cancelWait(params) };
        case "workbench/subagent/message": return { id, result: await this.withHarnessClient((client) => this.message(client, params)) };
        case "workbench/subagent/stop": return { id, result: await this.withHarnessClient((client) => this.stop(client, params)) };
        case "workbench/subagent/settle": return { id, result: await this.settle(params) };
        default: throw new Error(`Unsupported Workbench subagent method: ${message.method ?? "unknown"}`);
      }
    } catch (error) {
      return { id, error: { code: -32000, message: error instanceof Error ? error.message : "Workbench subagent request failed." } };
    }
  }

  mutateProfile(value: unknown) {
    return this.profileStore.mutate(value);
  }

  private async withHarnessClient<T>(operation: (client: WorkbenchSubagentHarnessClient) => Promise<T>) {
    const client = this.createHarnessClient();
    try {
      await client.connect(this.bridgeUrl);
      return await operation(client);
    } finally {
      client.close();
    }
  }

  private async requestHarness<T>(client: WorkbenchSubagentHarnessClient, harness: WorkbenchHarness, message: { method: string; params?: unknown } & Record<string, unknown>) {
    const response = await client.sendRequest<T>({ ...message, workbenchHarness: harness });
    if (isCodexJsonRpcFailure(response)) throw new Error(response.error.message);
    return response.result;
  }

  private async readThread(client: WorkbenchSubagentHarnessClient, harness: WorkbenchHarness, threadId: string, cwd: string) {
    return (await this.requestHarness<ThreadReadResponse>(client, harness, {
      method: "thread/read",
      params: { cwd, includeTurns: true, threadId },
      workbenchThreadHydration: { mode: "latest" },
    })).thread;
  }

  private async readThreadForWaitPoll(client: WorkbenchSubagentHarnessClient, record: WorkbenchSubagentRelationship) {
    if (record.harness !== "codex") {
      return await this.readThread(client, record.harness, record.threadId, record.cwd);
    }

    return (await this.requestHarness<ThreadReadResponse>(client, record.harness, {
      method: "thread/read",
      params: { cwd: record.cwd, includeTurns: false, threadId: record.threadId },
      workbenchRequestSource: "autoRefresh",
    })).thread;
  }

  private async readThreadForWaitBoundary(
    client: WorkbenchSubagentHarnessClient,
    record: WorkbenchSubagentRelationship,
    polledThread: Thread,
  ) {
    if (record.harness !== "codex" || polledThread.turns.length) {
      return polledThread;
    }

    return await this.readThread(client, record.harness, record.threadId, record.cwd);
  }

  private async resolveThreadHarness(
    client: WorkbenchSubagentHarnessClient,
    threadId: string,
    cwd: string,
    project: AgentEndpointProjectResolution["project"],
    label: string,
    knownHarness?: WorkbenchHarness,
  ) {
    for (const harness of getWorkbenchThreadHarnessCandidates(threadId, knownHarness)) {
      try {
        const thread = await this.readThread(client, harness, threadId, cwd);
        const threadProject = await this.resolveProjectFromCwd(thread.cwd, { endpointName: label });
        if (threadProject.project.id === project.id) return { harness, thread };
      } catch {
        // Try the next locally ordered provider candidate.
      }
    }
    throw new Error(`${label} does not belong to this cwd project.`);
  }

  private async resolveCaller(
    client: WorkbenchSubagentHarnessClient,
    params: Record<string, unknown>,
    {
      knownHarness,
      requestedProject,
    }: {
      knownHarness?: WorkbenchHarness;
      requestedProject?: AgentEndpointProjectResolution;
    } = {},
  ) {
    const callerThreadId = requiredString(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const resolvedProject = requestedProject ?? await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const caller = await this.resolveThreadHarness(
      client,
      callerThreadId,
      cwd,
      resolvedProject.project,
      "Workbench subagent caller",
      knownHarness,
    );
    return { callerThreadId, cwd, harness: caller.harness, project: resolvedProject.project };
  }

  private async list(params: Record<string, unknown>) {
    const cwd = requiredString(params, "cwd");
    const project = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent list" });
    const parentThreadId = typeof params.parentThreadId === "string" ? params.parentThreadId.trim() : requiredString(params, "callerThreadId");
    const relationships = (await this.subagentStore.list({ parentThreadId, projectId: project.project.id })).subagents;
    const joined: WorkbenchSubagentSummary[] = await Promise.all(relationships.map(async (relationship) => {
      const entry = await this.threadState?.getEntry(project.project.id, relationship.harness, relationship.threadId);
      return entry?.entryKind === "subagent"
        ? { ...relationship, activityStatus: entry.lifecycle.kind === "working" ? "active" as const : "inactive" as const, lastActivityAt: entry.activityAt, lifecycle: entry.lifecycle, pinned: entry.pinned }
        : { ...relationship, activityStatus: "unknown" as const, lastActivityAt: relationship.updatedAt, pinned: false };
    }));
    const wantsSettled = params.settled === true;
    const filtered = joined.filter((relationship) => Boolean(relationship.lifecycle?.settled) === wantsSettled).sort((left, right) => {
      const rank = (record: WorkbenchSubagentSummary) => record.lifecycle?.kind === "needsAttention" ? 0 : record.lifecycle?.kind === "completed" || record.lifecycle?.kind === "stopped" ? 1 : 2;
      return rank(left) - rank(right) || Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.lastActivityAt - left.lastActivityAt || left.threadId.localeCompare(right.threadId);
    });
    if (!wantsSettled) return { nextCursor: null, subagents: filtered };
    const offset = typeof params.cursor === "string" && /^\d+$/u.test(params.cursor) ? Number(params.cursor) : 0;
    const limit = typeof params.limit === "number" ? Math.min(20, Math.max(1, params.limit)) : 20;
    const subagents = filtered.slice(offset, offset + limit);
    return { nextCursor: offset + subagents.length < filtered.length ? String(offset + subagents.length) : null, subagents };
  }

  private async profiles(params: Record<string, unknown>) {
    const cwd = requiredString(params, "cwd");
    const project = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent profiles" });
    const profiles = (await this.profileStore.read()).profiles.filter((profile) => profile.scope.kind === "global" || profile.scope.projectId === project.project.id);
    return { profiles };
  }

  private buildPromptContext(caller: ResolvedSubagentCaller, profile: WorkbenchComposerProfile, threadId: string, name: string, workbenchOrigin: string | undefined) {
    return {
      agentPath: profile.agentPath,
      cwd: caller.cwd,
      harness: profile.harness,
      projectId: caller.project.id,
      roots: caller.project.roots.map((root, index) => ({ id: root.id, isPrimary: index === 0, name: root.name, relativePath: ".", rootPath: root.rootPath })),
      subagentName: name,
      threadId,
      workbenchOrigin: workbenchOrigin ?? null,
      workflowIds: ["subagent"],
    };
  }

  private async create(client: WorkbenchSubagentHarnessClient, params: Record<string, unknown>) {
    const caller = await this.resolveCaller(client, params);
    const relationships = await this.subagentStore.list({ projectId: caller.project.id });
    if (relationships.subagents.some(({ threadId }) => threadId === caller.callerThreadId)) {
      throw new Error("Workbench subagents cannot create their own subagents.");
    }
    const profileId = requiredString(params, "profileId");
    const name = requiredString(params, "name");
    const title = requiredString(params, "title");
    const userMessage = requiredString(params, "message");
    const workbenchOrigin = typeof params.workbenchOrigin === "string" ? params.workbenchOrigin : undefined;
    let result: { threadId: string } | null = null;
    const operation = this.createQueue.catch(() => undefined).then(async () => {
      const currentRelationships = await this.subagentStore.list({ parentThreadId: caller.callerThreadId, projectId: caller.project.id });
      const sameName = currentRelationships.subagents.filter((relationship) => relationship.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
      for (const relationship of sameName) {
        const entry = await this.threadState?.getEntry(caller.project.id, relationship.harness, relationship.threadId);
        if (!entry || entry.entryKind !== "subagent" || !entry.lifecycle.settled) throw new Error(`An unsettled direct child already owns the name ${relationship.name}.`);
      }
      const profile = (await this.profileStore.read()).profiles.find((candidate) => candidate.id === profileId);
      if (!profile || (profile.scope.kind === "project" && profile.scope.projectId !== caller.project.id)) throw new Error("That profile is not visible in this cwd project.");
      const reservationId = `pending:${randomUUID()}`;
      const now = Date.now();
      const reservation = await this.subagentStore.reserve({
        createdAt: now, cwd: caller.cwd, harness: profile.harness,
        name, parentThreadId: caller.callerThreadId, profileId: profile.id, profileName: profile.name,
        projectId: caller.project.id, threadId: reservationId, title, updatedAt: now,
      });
      let childId = "";
      try {
        const start = await this.requestHarness<{ thread: Thread }>(client, profile.harness, {
          method: "thread/start",
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: this.buildPromptContext(caller, profile, "", name, workbenchOrigin),
          params: { cwd: caller.cwd, effort: profile.reasoningEffort, ephemeral: false, model: profile.model, serviceTier: profile.serviceTier },
        });
        childId = start.thread.id;
        const startedAt = Date.now();
        const record = { ...reservation, threadId: childId, updatedAt: startedAt };
        await this.subagentStore.replace(caller.callerThreadId, reservationId, record);
        await this.onRelationshipCommitted(record);
        await this.requestHarness(client, profile.harness, { method: "thread/name/set", params: { cwd: caller.cwd, name: title, threadId: childId } });
        const turnContext = this.buildPromptContext(caller, profile, childId, name, workbenchOrigin);
        await this.requestHarness(client, profile.harness, {
          method: "turn/start",
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: turnContext,
          params: {
            ...(profile.harness === "codex" ? { collaborationMode: createQuestionnaireCollaborationMode(profile.model, profile.reasoningEffort) } : {}),
            cwd: caller.cwd, effort: profile.reasoningEffort,
            input: agentMessageInput(userMessage, PARENT_AGENT_NAME, caller.callerThreadId),
            model: profile.model,
            serviceTier: profile.serviceTier, summary: "detailed", threadId: childId,
          },
        });
        result = { threadId: childId };
      } catch (error) {
        if (!childId) {
          await this.subagentStore.remove(caller.callerThreadId, reservationId);
        }
        throw new Error(`${error instanceof Error ? error.message : String(error)}${childId ? ` (subagent thread ${childId})` : ""}`);
      }
    });
    this.createQueue = operation.then(() => undefined, () => undefined);
    await operation;
    if (!result) throw new Error("Subagent creation did not return a thread id.");
    return result;
  }

  private async ownedRecord(params: Record<string, unknown>) {
    const callerThreadId = requiredString(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const project = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const requestedName = typeof params.threadName === "string" ? params.threadName.trim() : typeof params.name === "string" ? params.name.trim() : "";
    let threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
    if (!threadId && requestedName) {
      const relationships = await this.subagentStore.list({ parentThreadId: callerThreadId, projectId: project.project.id });
      const matches = relationships.subagents.filter((record) => record.name.trim().toLocaleLowerCase() === requestedName.toLocaleLowerCase());
      const unsettled = [] as WorkbenchSubagentRelationship[];
      for (const record of matches) {
        const entry = await this.threadState?.getEntry(project.project.id, record.harness, record.threadId);
        if (!entry || entry.entryKind !== "subagent" || !entry.lifecycle.settled) unsettled.push(record);
      }
      if (unsettled.length !== 1) throw new Error(unsettled.length ? "That subagent name is ambiguous." : "That unsettled subagent name was not found.");
      threadId = unsettled[0]!.threadId;
    }
    if (!threadId) throw new Error("threadId or threadName is required.");
    const record = await this.subagentStore.getOwned(callerThreadId, project.project.id, threadId);
    if (!record) throw new Error("That subagent is not owned by the current thread.");
    return { caller: { callerThreadId, cwd, project: project.project }, record };
  }

  private async ownedRecords(params: Record<string, unknown>) {
    const callerThreadId = requiredString(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const project = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const threadIds = Array.isArray(params.threadIds) || typeof params.threadId === "string" ? requiredThreadIds(params) : [];
    const rawNames = Array.isArray(params.threadNames) ? params.threadNames : Array.isArray(params.names) ? params.names : [params.threadName ?? params.name];
    const threadNames = rawNames
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter(Boolean);
    if (!threadIds.length && !threadNames.length) throw new Error("threadIds or threadNames are required.");
    if (new Set(threadNames.map((name) => name.toLocaleLowerCase())).size !== threadNames.length) throw new Error("threadNames must be unique.");
    if (threadNames.length) {
      const relationships = await this.subagentStore.list({ parentThreadId: callerThreadId, projectId: project.project.id });
      for (const name of threadNames) {
        const matches = relationships.subagents.filter((record) => record.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
        const unsettled = [] as WorkbenchSubagentRelationship[];
        for (const record of matches) {
          const entry = await this.threadState?.getEntry(project.project.id, record.harness, record.threadId);
          if (!entry || entry.entryKind !== "subagent" || !entry.lifecycle.settled) unsettled.push(record);
        }
        if (unsettled.length !== 1) throw new Error(unsettled.length ? `Subagent name ${name} is ambiguous.` : `Unsettled subagent ${name} was not found.`);
        threadIds.push(unsettled[0]!.threadId);
      }
    }
    if (new Set(threadIds).size !== threadIds.length) throw new Error("Subagent targets must resolve uniquely.");
    const records = await this.subagentStore.getOwnedMany(callerThreadId, project.project.id, threadIds);
    if (!records) {
      throw new Error("Every requested subagent must be owned by the current thread.");
    }
    return records;
  }

  private async assertUnlocked(projectId: string, records: readonly WorkbenchSubagentRelationship[]) {
    if (!this.threadState) return;
    const entries = await Promise.all(records.map((record) => this.threadState!.getEntry(projectId, record.harness, record.threadId)));
    const locked = entries.find((entry) => entry?.entryKind === "subagent" && entry.pinned);
    if (locked?.entryKind === "subagent") throw new Error(`Subagent ${locked.name} is locked: this subagent is user-owned and may send you follow-up messages.`);
  }

  private async pendingQuestionnaires(client: WorkbenchSubagentHarnessClient, harness: WorkbenchHarness, cwd: string) {
    return (await this.requestHarness<PendingQuestionnaireList>(client, harness, {
      method: "questionnaire/list",
      params: { cwd },
      workbenchRequestSource: "autoRefresh",
    })).data;
  }

  private async pendingQuestionnaire(client: WorkbenchSubagentHarnessClient, record: WorkbenchSubagentRelationship) {
    return (await this.pendingQuestionnaires(client, record.harness, record.cwd)).find((entry) => entry.threadId === record.threadId) ?? null;
  }

  private async wait(client: WorkbenchSubagentHarnessClient, params: Record<string, unknown>) {
    const records = await this.ownedRecords(params);
    await this.assertUnlocked(records[0]!.projectId, records);
    const waitId = requiredString(params, "waitId");
    if (this.waiters.has(waitId)) throw new Error("That subagent wait id is already active.");
    const controller = new AbortController(); this.waiters.set(waitId, controller);
    try {
      if (this.threadState) {
        const recordKeys = new Set(records.map((record) => `${record.harness}:${record.threadId}`));
        const selectReady = async () => {
          for (const record of records) {
            const entry = await this.threadState!.getEntry(record.projectId, record.harness, record.threadId);
            if (entry?.entryKind === "subagent" && (entry.pinned || entry.lifecycle.kind !== "working")) return { entry, record };
          }
          return null;
        };
        let ready = await selectReady();
        if (!ready) {
          ready = await new Promise<{ entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }>; record: WorkbenchSubagentRelationship }>((resolve, reject) => {
            const unsubscribe = this.threadState!.subscribe((projectId, entry) => {
              if (entry.entryKind !== "subagent" || projectId !== records[0]!.projectId || !recordKeys.has(`${entry.identity.harness}:${entry.identity.threadId}`)) return;
              if (!entry.pinned && entry.lifecycle.kind === "working") return;
              const record = records.find((candidate) => candidate.threadId === entry.identity.threadId && candidate.harness === entry.identity.harness);
              if (!record) return;
              cleanup();
              resolve({ entry, record });
            });
            const onAbort = () => { cleanup(); reject(controller.signal.reason); };
            const cleanup = () => { unsubscribe(); controller.signal.removeEventListener("abort", onAbort); };
            controller.signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        if (ready.entry.pinned) return { output: `Subagent ${ready.record.name} (${ready.record.threadId}) was locked by the user.` };
        const thread = await this.readThread(client, ready.record.harness, ready.record.threadId, ready.record.cwd);
        const pending = ready.entry.lifecycle.kind === "needsAttention" && ready.entry.lifecycle.reason === "pendingInput"
          ? await this.pendingQuestionnaire(client, ready.record)
          : null;
        return { output: renderSubagentWaitResultOutput({
          multiplexed: records.length > 1,
          name: ready.record.name,
          outcome: pending ? "needs-interaction" : "finished",
          output: pending ? renderSubagentQuestionnaireOutput(thread, pending.request) : renderSubagentTurnOutput(thread),
          threadId: ready.record.threadId,
        }) };
      }
      while (true) {
        const pendingByScope = new Map<string, Promise<PendingQuestionnaireList["data"]>>();
        const states = await Promise.all(records.map(async (record) => {
          const scopeKey = `${record.harness}\0${record.cwd}`;
          let pendingPromise = pendingByScope.get(scopeKey);
          if (!pendingPromise) {
            pendingPromise = this.pendingQuestionnaires(client, record.harness, record.cwd);
            pendingByScope.set(scopeKey, pendingPromise);
          }
          const [thread, pending] = await Promise.all([
            this.readThreadForWaitPoll(client, record),
            pendingPromise,
          ]);
          return { pending: pending.find((entry) => entry.threadId === record.threadId) ?? null, record, thread };
        }));
        const questionnaireState = states.find((state) => state.pending);
        if (questionnaireState?.pending) {
          const thread = await this.readThreadForWaitBoundary(
            client,
            questionnaireState.record,
            questionnaireState.thread,
          );
          return { output: renderSubagentWaitResultOutput({
            multiplexed: records.length > 1,
            name: questionnaireState.record.name,
            outcome: "needs-interaction",
            output: renderSubagentQuestionnaireOutput(thread, questionnaireState.pending.request),
            threadId: questionnaireState.record.threadId,
          }) };
        }
        const finishedState = states.find((state) => state.record.harness === "codex"
          ? state.thread.status.type === "idle" || state.thread.status.type === "systemError"
          : !isTurnActive(state.thread));
        if (finishedState) {
          const thread = await this.readThreadForWaitBoundary(client, finishedState.record, finishedState.thread);
          if (
            finishedState.record.harness === "codex"
            && (thread.status.type === "active" || thread.status.type === "notLoaded")
          ) {
            await delay(POLL_INTERVAL_MS, controller.signal);
            continue;
          }
          return { output: renderSubagentWaitResultOutput({
            multiplexed: records.length > 1,
            name: finishedState.record.name,
            outcome: "finished",
            output: renderSubagentTurnOutput(thread),
            threadId: finishedState.record.threadId,
          }) };
        }
        await delay(POLL_INTERVAL_MS, controller.signal);
      }
    } finally {
      this.waiters.delete(waitId);
    }
  }

  private cancelWait(params: Record<string, unknown>) {
    const waitId = requiredString(params, "waitId");
    const waiter = this.waiters.get(waitId);
    waiter?.abort(new Error("Subagent wait cancelled."));
    return { cancelled: Boolean(waiter) };
  }

  private async message(client: WorkbenchSubagentHarnessClient, params: Record<string, unknown>) {
    if (params.parent === true) {
      return await this.messageParent(client, params);
    }
    const { caller, record } = await this.ownedRecord(params);
    await this.assertUnlocked(record.projectId, [record]);
    const message = requiredString(params, "message");
    const input = agentMessageInput(message, PARENT_AGENT_NAME, caller.callerThreadId);
    const thread = await this.readThread(client, record.harness, record.threadId, record.cwd);
    const turn = currentTurn(thread);
    const pending = await this.pendingQuestionnaire(client, record);
    if (turn?.status === "inProgress") {
      await this.requestHarness(client, record.harness, {
        method: "turn/steer",
        params: { cwd: record.cwd, expectedTurnId: turn.id, input, threadId: record.threadId },
      });
      if (pending) await this.requestHarness(client, record.harness, {
        method: "questionnaire/respond",
        params: { requestKey: pending.requestKey, response: createEmptySubagentQuestionnaireResponse(pending.request), threadId: record.threadId, turnId: pending.turnId },
      });
      return {};
    }
    const profile = (await this.profileStore.read()).profiles.find((candidate) => candidate.id === record.profileId);
    if (!profile) throw new Error("The subagent profile no longer exists.");
    await this.requestHarness(client, record.harness, {
      method: "turn/start",
      [WORKBENCH_PROMPT_CONTEXT_FIELD]: this.buildPromptContext(caller, profile, record.threadId, record.name, typeof params.workbenchOrigin === "string" ? params.workbenchOrigin : undefined),
      params: {
        ...(record.harness === "codex" ? { collaborationMode: createQuestionnaireCollaborationMode(profile.model, profile.reasoningEffort) } : {}),
        cwd: record.cwd, effort: profile.reasoningEffort, input, model: profile.model,
        serviceTier: profile.serviceTier, summary: "detailed", threadId: record.threadId,
      },
    });
    return {};
  }

  private async messageParent(client: WorkbenchSubagentHarnessClient, params: Record<string, unknown>) {
    const callerThreadId = requiredString(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const requestedProject = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const relationships = await this.subagentStore.list({ projectId: requestedProject.project.id });
    const relationship = relationships.subagents.find(({ threadId }) => threadId === callerThreadId) ?? null;
    if (!relationship) {
      throw new Error("The current thread is not a Workbench subagent with a direct parent in this project.");
    }
    const caller = await this.resolveCaller(client, params, { knownHarness: relationship.harness, requestedProject });
    const parent = await this.resolveThreadHarness(
      client,
      relationship.parentThreadId,
      relationship.cwd,
      caller.project,
      "Workbench subagent parent",
    );
    const input = agentMessageInput(
      requiredString(params, "message"),
      relationship.name,
      relationship.threadId,
    );
    const turn = currentTurn(parent.thread);
    if (turn?.status === "inProgress") {
      await this.requestHarness(client, parent.harness, {
        method: "turn/steer",
        params: {
          cwd: parent.thread.cwd,
          expectedTurnId: turn.id,
          input,
          threadId: parent.thread.id,
        },
      });
      return {};
    }
    await this.requestHarness(client, parent.harness, {
      method: "turn/start",
      params: { cwd: parent.thread.cwd, input, threadId: parent.thread.id },
    });
    return {};
  }

  private async stop(client: WorkbenchSubagentHarnessClient, params: Record<string, unknown>) {
    const records = await this.ownedRecords(params);
    await this.assertUnlocked(records[0]!.projectId, records);
    for (const record of records) {
      const thread = await this.readThread(client, record.harness, record.threadId, record.cwd);
      const turn = currentTurn(thread);
      if (turn?.status === "inProgress") await this.requestHarness(client, record.harness, { method: "turn/interrupt", params: { cwd: record.cwd, threadId: record.threadId, turnId: turn.id } });
    }
    return {};
  }

  private async settle(params: Record<string, unknown>) {
    if (!this.threadState) throw new Error("Subagent lifecycle state is unavailable.");
    const records = await this.ownedRecords(params);
    await this.assertUnlocked(records[0]!.projectId, records);
    for (const record of records) {
      const entry = await this.threadState.getEntry(record.projectId, record.harness, record.threadId);
      if (entry?.entryKind !== "subagent" || (entry.lifecycle.kind !== "completed" && entry.lifecycle.kind !== "stopped")) {
        throw new Error(`Subagent ${record.name} can be settled only after it is Completed or Stopped.`);
      }
    }
    for (const record of records) {
      await this.threadState.mutate({ identity: { harness: record.harness, threadId: record.threadId }, method: "workbench/thread-state/settle", projectId: record.projectId });
    }
    return { settled: records.map(({ name, threadId }) => ({ name, threadId })) };
  }
}
