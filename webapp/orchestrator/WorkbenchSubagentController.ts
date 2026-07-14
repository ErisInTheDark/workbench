/*
 * Exports:
 * - WorkbenchSubagentControllerReloadState: active-wait state preserved across Codex bridge reloads. Keywords: subagent, reload, waiter, lifecycle.
 * - default WorkbenchSubagentController: own durable parent-child metadata, authorization, cross-harness lifecycle, and wait cancellation. Keywords: orchestrator, subagent, controller, ownership, wait.
 */
import { randomUUID } from "node:crypto";

import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import { CodexAppServerClient } from "../lib/codex/app-server-client";
import { createQuestionnaireCollaborationMode, isCodexJsonRpcFailure } from "../lib/codex/protocol";
import type {
  WorkbenchComposerProfile,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchSubagentSummary,
} from "../lib/types";
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
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
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

export interface WorkbenchSubagentControllerReloadState {
  controller: WorkbenchSubagentController;
}

const POLL_INTERVAL_MS = 300;
const WORKBENCH_PROMPT_CONTEXT_FIELD = "workbenchPromptContext";

type WorkbenchSubagentHarnessClient = Pick<CodexAppServerClient, "close" | "connect" | "sendRequest">;

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
  private readonly profileStore: WorkbenchComposerProfileStore;
  private readonly subagentStore: WorkbenchSubagentStore;
  private readonly waiters = new Map<string, AbortController>();

  constructor({
    bridgeUrl,
    createHarnessClient = () => new CodexAppServerClient(),
    storageRoot,
    subagentStore = new WorkbenchSubagentStore(storageRoot),
  }: {
    bridgeUrl: string;
    createHarnessClient?: () => WorkbenchSubagentHarnessClient;
    storageRoot: string;
    subagentStore?: WorkbenchSubagentStore;
  }) {
    this.bridgeUrl = bridgeUrl;
    this.createHarnessClient = createHarnessClient;
    this.profileStore = new WorkbenchComposerProfileStore(storageRoot);
    this.subagentStore = subagentStore;
  }

  hasActiveWaiters() { return this.waiters.size > 0; }
  dispose() { for (const waiter of this.waiters.values()) waiter.abort(new Error("Subagent controller stopped.")); this.waiters.clear(); }

  async handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = message.id ?? null;
    try {
      const params = isRecord(message.params) ? message.params : {};
      switch (message.method) {
        case "workbench/composerProfiles/read": return { id, result: await this.profileStore.read() };
        case "workbench/composerProfiles/importLegacy": return { id, result: await this.profileStore.importLegacy(params.profiles) };
        case "workbench/composerProfiles/mutate": return { id, result: await this.profileStore.mutate(params.mutation) };
        case "workbench/subagent/list": return { id, result: await this.list(params) };
        case "workbench/subagent/profiles": return { id, result: await this.profiles(params) };
        case "workbench/subagent/create": return { id, result: await this.withHarnessClient((client) => this.create(client, params)) };
        case "workbench/subagent/wait": return { id, result: await this.withHarnessClient((client) => this.wait(client, params)) };
        case "workbench/subagent/waitCancel": return { id, result: this.cancelWait(params) };
        case "workbench/subagent/message": return { id, result: await this.withHarnessClient((client) => this.message(client, params)) };
        case "workbench/subagent/stop": return { id, result: await this.withHarnessClient((client) => this.stop(client, params)) };
        default: throw new Error(`Unsupported Workbench subagent method: ${message.method ?? "unknown"}`);
      }
    } catch (error) {
      return { id, error: { code: -32000, message: error instanceof Error ? error.message : "Workbench subagent request failed." } };
    }
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

  private async resolveCaller(client: WorkbenchSubagentHarnessClient, params: Record<string, unknown>) {
    const callerThreadId = requiredString(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const requestedProject = await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const matches = (await Promise.all((["codex", "copilot", "opencode"] as const).map(async (harness) => {
      try {
        const thread = await this.readThread(client, harness, callerThreadId, cwd);
        const threadProject = await resolveAgentEndpointProjectFromCwd(thread.cwd, { endpointName: "Workbench subagent caller" });
        return threadProject.project.id === requestedProject.project.id ? { harness, thread } : null;
      } catch { return null; }
    }))).filter((match): match is { harness: WorkbenchHarness; thread: Thread } => Boolean(match));
    if (matches.length !== 1) throw new Error(matches.length ? "Caller thread identity is ambiguous." : "Caller thread does not belong to this cwd project.");
    return { callerThreadId, cwd, harness: matches[0].harness, project: requestedProject.project };
  }

  private async list(params: Record<string, unknown>) {
    const cwd = requiredString(params, "cwd");
    const project = await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench subagent list" });
    const parentThreadId = typeof params.parentThreadId === "string" ? params.parentThreadId.trim() : "";
    const cursor = typeof params.cursor === "string" ? params.cursor.trim() : null;
    const limit = typeof params.limit === "number" ? params.limit : null;
    return await this.subagentStore.list({ cursor, limit, parentThreadId, projectId: project.project.id });
  }

  private async profiles(params: Record<string, unknown>) {
    const cwd = requiredString(params, "cwd");
    const project = await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench subagent profiles" });
    const profiles = (await this.profileStore.read()).profiles.filter((profile) => profile.scope.kind === "global" || profile.scope.projectId === project.project.id);
    return { profiles };
  }

  private buildPromptContext(caller: ResolvedSubagentCaller, profile: WorkbenchComposerProfile, threadId: string, name: string, workbenchOrigin: string | undefined, instructionScope?: "threadUtilities") {
    return {
      agentPath: profile.agentPath,
      harness: profile.harness,
      ...(instructionScope ? { instructionScope } : {}),
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
    const profileId = requiredString(params, "profileId");
    const name = requiredString(params, "name");
    const title = requiredString(params, "title");
    const userMessage = requiredString(params, "message");
    const workbenchOrigin = typeof params.workbenchOrigin === "string" ? params.workbenchOrigin : undefined;
    let result: { threadId: string } | null = null;
    const operation = this.createQueue.catch(() => undefined).then(async () => {
      const profile = (await this.profileStore.read()).profiles.find((candidate) => candidate.id === profileId);
      if (!profile || (profile.scope.kind === "project" && profile.scope.projectId !== caller.project.id)) throw new Error("That profile is not visible in this cwd project.");
      const reservationId = `pending:${randomUUID()}`;
      const now = Date.now();
      const reservation: WorkbenchSubagentSummary = {
        activityStatus: "unknown", createdAt: now, cwd: caller.cwd, harness: profile.harness, lastActivityAt: now,
        name, parentThreadId: caller.callerThreadId, profileId: profile.id, profileName: profile.name,
        projectId: caller.project.id, threadId: reservationId, title, updatedAt: now,
      };
      await this.subagentStore.reserve(reservation);
      let childId = "";
      try {
        const start = await this.requestHarness<{ thread: Thread }>(client, profile.harness, {
          method: "thread/start",
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: this.buildPromptContext(caller, profile, "", name, workbenchOrigin),
          params: { cwd: caller.cwd, ephemeral: false, model: profile.model, serviceTier: profile.serviceTier },
        });
        childId = start.thread.id;
        const startedAt = Date.now();
        const record = { ...reservation, activityStatus: "active" as const, lastActivityAt: startedAt, threadId: childId, updatedAt: startedAt };
        await this.subagentStore.replace(caller.callerThreadId, reservationId, record);
        await this.requestHarness(client, profile.harness, { method: "thread/name/set", params: { cwd: caller.cwd, name: title, threadId: childId } });
        const turnContext = this.buildPromptContext(caller, profile, childId, name, workbenchOrigin, profile.harness === "codex" ? "threadUtilities" : undefined);
        await this.requestHarness(client, profile.harness, {
          method: "turn/start",
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: turnContext,
          params: {
            ...(profile.harness === "codex" ? { collaborationMode: createQuestionnaireCollaborationMode(profile.model, profile.reasoningEffort) } : {}),
            cwd: caller.cwd, effort: profile.reasoningEffort, input: textInput(userMessage), model: profile.model,
            serviceTier: profile.serviceTier, summary: "detailed", threadId: childId,
          },
        });
        result = { threadId: childId };
      } catch (error) {
        if (!childId) {
          await this.subagentStore.remove(caller.callerThreadId, reservationId);
        } else {
          await this.subagentStore.markActivity(childId, "inactive");
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
    const project = await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const threadId = requiredString(params, "threadId");
    const record = await this.subagentStore.getOwned(callerThreadId, project.project.id, threadId);
    if (!record) throw new Error("That subagent is not owned by the current thread.");
    return { caller: { callerThreadId, cwd, project: project.project }, record };
  }

  private async ownedRecords(params: Record<string, unknown>) {
    const callerThreadId = requiredString(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const project = await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const threadIds = requiredThreadIds(params);
    const records = await this.subagentStore.getOwnedMany(callerThreadId, project.project.id, threadIds);
    if (!records) {
      throw new Error("Every requested subagent must be owned by the current thread.");
    }
    return records;
  }

  private async pendingQuestionnaires(client: WorkbenchSubagentHarnessClient, harness: WorkbenchHarness, cwd: string) {
    return (await this.requestHarness<PendingQuestionnaireList>(client, harness, { method: "questionnaire/list", params: { cwd } })).data;
  }

  private async pendingQuestionnaire(client: WorkbenchSubagentHarnessClient, record: WorkbenchSubagentSummary) {
    return (await this.pendingQuestionnaires(client, record.harness, record.cwd)).find((entry) => entry.threadId === record.threadId) ?? null;
  }

  private async wait(client: WorkbenchSubagentHarnessClient, params: Record<string, unknown>) {
    const records = await this.ownedRecords(params);
    const waitId = requiredString(params, "waitId");
    if (this.waiters.has(waitId)) throw new Error("That subagent wait id is already active.");
    const controller = new AbortController(); this.waiters.set(waitId, controller);
    try {
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
            this.readThread(client, record.harness, record.threadId, record.cwd),
            pendingPromise,
          ]);
          return { pending: pending.find((entry) => entry.threadId === record.threadId) ?? null, record, thread };
        }));
        const questionnaireState = states.find((state) => state.pending);
        if (questionnaireState?.pending) {
          return { output: renderSubagentWaitResultOutput({
            multiplexed: records.length > 1,
            name: questionnaireState.record.name,
            outcome: "needs-interaction",
            output: renderSubagentQuestionnaireOutput(questionnaireState.thread, questionnaireState.pending.request),
            threadId: questionnaireState.record.threadId,
          }) };
        }
        const finishedState = states.find((state) => !isTurnActive(state.thread));
        if (finishedState) {
          return { output: renderSubagentWaitResultOutput({
            multiplexed: records.length > 1,
            name: finishedState.record.name,
            outcome: "finished",
            output: renderSubagentTurnOutput(finishedState.thread),
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
    const { caller, record } = await this.ownedRecord(params);
    const message = requiredString(params, "message");
    const thread = await this.readThread(client, record.harness, record.threadId, record.cwd);
    const turn = currentTurn(thread);
    const pending = await this.pendingQuestionnaire(client, record);
    if (turn?.status === "inProgress") {
      await this.requestHarness(client, record.harness, { method: "turn/steer", params: { cwd: record.cwd, expectedTurnId: turn.id, input: textInput(message), threadId: record.threadId } });
      if (pending) await this.requestHarness(client, record.harness, {
        method: "questionnaire/respond",
        params: { requestKey: pending.requestKey, response: createEmptySubagentQuestionnaireResponse(pending.request), threadId: record.threadId, turnId: pending.turnId },
      });
      await this.subagentStore.markActivity(record.threadId, "active");
      return {};
    }
    const profile = (await this.profileStore.read()).profiles.find((candidate) => candidate.id === record.profileId);
    if (!profile) throw new Error("The subagent profile no longer exists.");
    await this.requestHarness(client, record.harness, {
      method: "turn/start",
      [WORKBENCH_PROMPT_CONTEXT_FIELD]: this.buildPromptContext(caller, profile, record.threadId, record.name, typeof params.workbenchOrigin === "string" ? params.workbenchOrigin : undefined, record.harness === "codex" ? "threadUtilities" : undefined),
      params: {
        ...(record.harness === "codex" ? { collaborationMode: createQuestionnaireCollaborationMode(profile.model, profile.reasoningEffort) } : {}),
        cwd: record.cwd, effort: profile.reasoningEffort, input: textInput(message), model: profile.model,
        serviceTier: profile.serviceTier, summary: "detailed", threadId: record.threadId,
      },
    });
    await this.subagentStore.markActivity(record.threadId, "active");
    return {};
  }

  private async stop(client: WorkbenchSubagentHarnessClient, params: Record<string, unknown>) {
    const { record } = await this.ownedRecord(params);
    const thread = await this.readThread(client, record.harness, record.threadId, record.cwd);
    const turn = currentTurn(thread);
    if (turn?.status === "inProgress") await this.requestHarness(client, record.harness, { method: "turn/interrupt", params: { cwd: record.cwd, threadId: record.threadId, turnId: turn.id } });
    await this.subagentStore.markActivity(record.threadId, "inactive");
    return {};
  }
}
