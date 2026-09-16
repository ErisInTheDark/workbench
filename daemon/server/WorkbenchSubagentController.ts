/*
 * Exports:
 * - WorkbenchSubagentControllerOptions: provider operations, durable store and validated project dependencies.
 * - default WorkbenchSubagentController: own durable parent-child metadata, authorization, cross-harness lifecycle, and wait cancellation.
 */
import { randomUUID } from "node:crypto";

import type {
  ThreadPayload,
  WorkbenchHarness,
  WorkbenchPendingUserInputRequest,
  WorkbenchSubagentRelationship,
  WorkbenchSubagentSummary,
} from "workbench-shared/types";
import {
  resolveAgentEndpointProjectFromCwd,
  type AgentEndpointProjectResolution,
} from "./lib/workbench/project/agent-endpoint-project";
import {
  createEmptySubagentQuestionnaireResponse,
  renderSubagentQuestionnaireOutput,
  renderSubagentTurnOutput,
  renderSubagentWaitResultOutput,
} from "./lib/workbench/subagent/subagent-output";
import type WorkbenchProvider from "./WorkbenchProvider";
import type { WorkbenchMessageContext } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import { ThreadReferenceSchema, type ProjectId, type ThreadReference, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { copyComposerSettings } from "workbench-shared/workbench/thread/thread-profile";

interface PendingQuestionnaireList {
  data: Array<Omit<WorkbenchPendingUserInputRequest, "harness">>;
}

const POLL_INTERVAL_MS = 1_000;
const PARENT_AGENT_NAME = "parent agent";
type WorkbenchSubagentControllerStore = Pick<
  WorkbenchSubagentStore,
  "getOwned" | "getOwnedMany" | "list" | "remove" | "replace" | "reserve"
>;

export interface WorkbenchSubagentControllerOptions {
  provider(harness: WorkbenchHarness): Pick<WorkbenchProvider, "threads" | "interactions">;
  publicThreadId: (threadId: WorkbenchThreadId | ThreadReference, projectId: ProjectId) => Promise<WorkbenchThreadId>;
  identities: Pick<WorkbenchThreadIdentityController, "resolve" | "knownThread">;
  onRelationshipCommitted(record: WorkbenchSubagentRelationship): Promise<void>;
  profileStore: Pick<WorkbenchComposerProfileStore, "read" | "mutate">;
  resolveProjectFromCwd?: typeof resolveAgentEndpointProjectFromCwd;
  subagentStore: WorkbenchSubagentControllerStore;
  threadState?: {
    getEntry(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchThreadSidebarEntry | null>;
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

function currentTurn(thread: ThreadPayload) {
  return thread.turns.at(-1) ?? null;
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
  private readonly provider: WorkbenchSubagentControllerOptions["provider"];
  private readonly publicThreadId: NonNullable<WorkbenchSubagentControllerOptions["publicThreadId"]>;
  private readonly identities: WorkbenchSubagentControllerOptions["identities"];
  private createQueue: Promise<void> = Promise.resolve();
  private readonly onRelationshipCommitted: WorkbenchSubagentControllerOptions["onRelationshipCommitted"];
  private readonly profileStore: WorkbenchSubagentControllerOptions["profileStore"];
  private readonly resolveProjectFromCwd: typeof resolveAgentEndpointProjectFromCwd;
  private readonly subagentStore: WorkbenchSubagentControllerStore;
  private readonly threadState: WorkbenchSubagentControllerOptions["threadState"];
  private readonly waiters = new Map<string, AbortController>();
  private active = true;
  // Creation ordering cannot account for admitted messages, stops and waits.
  private readonly requests = new Set<Promise<JsonRpcResponse>>();

  constructor({
    provider,
    publicThreadId,
    identities,
    onRelationshipCommitted,
    profileStore,
    resolveProjectFromCwd = resolveAgentEndpointProjectFromCwd,
    subagentStore,
    threadState,
  }: WorkbenchSubagentControllerOptions) {
    this.provider = provider;
    this.publicThreadId = publicThreadId;
    this.identities = identities;
    this.onRelationshipCommitted = onRelationshipCommitted;
    this.profileStore = profileStore;
    this.resolveProjectFromCwd = resolveProjectFromCwd;
    this.subagentStore = subagentStore;
    this.threadState = threadState;
  }

  beginRuntimeDrain() {
    this.active = false;
    for (const waiter of this.waiters.values()) waiter.abort(new Error("Subagent wait cancelled for runtime reload."));
    this.waiters.clear();
  }

  async dispose() {
    this.beginRuntimeDrain();
    await Promise.all(this.requests);
  }

  handleRequest(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const operation = Promise.resolve().then(() => this.handleRequestOwned(message));
    this.requests.add(operation);
    return operation.finally(() => this.requests.delete(operation));
  }

  private async handleRequestOwned(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = message.id ?? null;
    try {
      if (!this.active) throw new Error("Subagent controller is draining for runtime reload.");
      const params = isRecord(message.params) ? { ...message.params } : {};
      if (this.identities && message.method !== "workbench/subagent/waitCancel") {
        const { project } = await this.resolveProjectFromCwd(requiredString(params, "cwd"), { endpointName: "Workbench subagent" });
        const canonicalId = async (threadId: string) => {
          const identity = await this.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId: project.id });
          if (!identity) throw new Error("Subagent thread identity is unavailable in this project.");
          return identity.threadId;
        };
        for (const key of ["callerThreadId", "parentThreadId", "threadId"] as const) {
          if (typeof params[key] === "string") params[key] = await canonicalId(params[key]);
        }
        if (Array.isArray(params.threadIds)) params.threadIds = await Promise.all(params.threadIds.map((threadId) => {
          if (typeof threadId !== "string") throw new Error("Subagent thread IDs must be strings.");
          return canonicalId(threadId);
        }));
      }
      switch (message.method) {
        case "workbench/subagent/list": return { id, result: await this.list(params) };
        case "workbench/subagent/profiles": return { id, result: await this.profiles(params) };
        case "workbench/subagent/create": return { id, result: await this.create(params) };
        case "workbench/subagent/wait": return { id, result: await this.wait(params) };
        case "workbench/subagent/waitCancel": return { id, result: this.cancelWait(params) };
        case "workbench/subagent/message": return { id, result: await this.message(params) };
        case "workbench/subagent/stop": return { id, result: await this.stop(params) };
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

  private readThreadId(params: Record<string, unknown>, key: string) {
    return this.identities.knownThread(ThreadReferenceSchema.parse(requiredString(params, key))).threadId;
  }

  private async resolveThreadHarness(
    threadId: string,
    cwd: string,
    project: AgentEndpointProjectResolution["project"],
    label: string,
    knownHarness?: WorkbenchHarness,
  ) {
    const identity = await this.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId: project.id });
    if (!identity) throw new Error(`${label} has no admitted identity.`);
    const nativeHarness = identity.bindings[0]?.harness ?? knownHarness;
    if (!nativeHarness) throw new Error(`${label} has no native execution.`);
    const harness = WorkbenchHarnessSchema.parse(nativeHarness);
    const thread = await this.provider(harness).threads.read(identity.threadId);
    const threadProject = await this.resolveProjectFromCwd(thread.cwd, { endpointName: label });
    if (threadProject.project.id === project.id) return { harness, thread, threadId: identity.threadId };
    throw new Error(`${label} does not belong to this cwd project.`);
  }

  private async resolveCaller(
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
      callerThreadId,
      cwd,
      resolvedProject.project,
      "Workbench subagent caller",
      knownHarness,
    );
    return { callerThreadId: caller.threadId, cwd, harness: caller.harness, project: resolvedProject.project };
  }

  private async list(params: Record<string, unknown>) {
    const cwd = requiredString(params, "cwd");
    const project = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent list" });
    const parentThreadId = this.readThreadId(params, typeof params.parentThreadId === "string" ? "parentThreadId" : "callerThreadId");
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

  private buildPromptContext(name: string, workbenchOrigin: string | undefined): WorkbenchMessageContext {
    return {
      subagentName: name,
      workbenchOrigin: workbenchOrigin ?? null,
      workflowIds: ["subagent"],
    };
  }

  private async create(params: Record<string, unknown>) {
    const caller = await this.resolveCaller(params);
    const relationships = await this.subagentStore.list({ projectId: caller.project.id });
    if (relationships.subagents.some(({ threadId }) => threadId === caller.callerThreadId)) {
      throw new Error("Workbench subagents cannot create their own subagents.");
    }
    const profileId = requiredString(params, "profileId");
    const name = requiredString(params, "name");
    const title = requiredString(params, "title");
    const userMessage = requiredString(params, "message");
    const workbenchOrigin = typeof params.workbenchOrigin === "string" ? params.workbenchOrigin : undefined;
    let result: { threadId: WorkbenchThreadId } | null = null;
    const operation = this.createQueue.catch(() => undefined).then(async () => {
      const currentRelationships = await this.subagentStore.list({ parentThreadId: caller.callerThreadId, projectId: caller.project.id });
      const sameName = currentRelationships.subagents.filter((relationship) => relationship.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
      for (const relationship of sameName) {
        const entry = await this.threadState?.getEntry(caller.project.id, relationship.harness, relationship.threadId);
        if (!entry || entry.entryKind !== "subagent" || !entry.lifecycle.settled) throw new Error(`An unsettled direct child already owns the name ${relationship.name}.`);
      }
      const profile = (await this.profileStore.read()).profiles.find((candidate) => candidate.id === profileId);
      if (!profile || (profile.scope.kind === "project" && profile.scope.projectId !== caller.project.id)) throw new Error("That profile is not visible in this cwd project.");
      const reservationId = randomUUID();
      const now = Date.now();
      const reservation = await this.subagentStore.reserve({
        createdAt: now, cwd: caller.cwd, harness: profile.harness,
        name, parentThreadId: caller.callerThreadId, profileId: profile.id, profileName: profile.name,
        projectId: caller.project.id, reservationId, title, updatedAt: now,
      });
      let childId: WorkbenchThreadId | null = null;
      try {
        const threads = this.provider(profile.harness).threads;
        const start = await threads.create({
          cwd: caller.cwd,
          profile: { kind: "profile", profileId: profile.id, settings: copyComposerSettings(profile) },
          context: this.buildPromptContext(name, workbenchOrigin),
        });
        childId = await this.publicThreadId(ThreadReferenceSchema.parse(start.id), caller.project.id);
        const startedAt = Date.now();
        const { reservationId: _reservationId, ...metadata } = reservation;
        const record = { ...metadata, threadId: childId, updatedAt: startedAt };
        await this.subagentStore.replace(caller.callerThreadId, reservationId, record);
        await this.onRelationshipCommitted(record);
        await threads.rename(childId, title);
        await threads.messageAgent({
          threadId: childId, cwd: caller.cwd, context: this.buildPromptContext(name, workbenchOrigin),
          message: { message: userMessage, senderName: PARENT_AGENT_NAME, senderThreadId: caller.callerThreadId },
        });
        result = { threadId: childId };
      } catch (error) {
        try {
          // Removal by reservation ID leaves an activated child's membership intact.
          await this.subagentStore.remove(caller.callerThreadId, reservationId);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Subagent creation failed and its reservation could not be released.");
        }
        throw new Error(`${error instanceof Error ? error.message : String(error)}${childId ? ` (subagent thread ${await this.publicThreadId(childId, caller.project.id)})` : ""}`);
      }
    });
    this.createQueue = operation.then(() => undefined, () => undefined);
    await operation;
    if (!result) throw new Error("Subagent creation did not return a thread id.");
    return result;
  }

  private async ownedRecord(params: Record<string, unknown>) {
    const callerThreadId = this.readThreadId(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const project = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const requestedName = typeof params.threadName === "string" ? params.threadName.trim() : typeof params.name === "string" ? params.name.trim() : "";
    let threadId = typeof params.threadId === "string" && params.threadId.trim() ? this.readThreadId(params, "threadId") : null;
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
    return { caller: { callerThreadId: record.parentThreadId, cwd, project: project.project }, record };
  }

  private async ownedRecords(params: Record<string, unknown>) {
    const callerThreadId = this.readThreadId(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const project = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const threadIds = Array.isArray(params.threadIds) || typeof params.threadId === "string"
      ? requiredThreadIds(params).map(threadId => this.identities.knownThread(ThreadReferenceSchema.parse(threadId)).threadId) : [];
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

  private async assertUnlocked(projectId: ProjectId, records: readonly WorkbenchSubagentRelationship[]) {
    if (!this.threadState) return;
    const entries = await Promise.all(records.map((record) => this.threadState!.getEntry(projectId, record.harness, record.threadId)));
    const locked = entries.find((entry) => entry?.entryKind === "subagent" && entry.pinned);
    if (locked?.entryKind === "subagent") throw new Error(`Subagent ${locked.name} is locked: this subagent is user-owned and may send you follow-up messages.`);
  }

  private async pendingQuestionnaires(harness: WorkbenchHarness) {
    return await this.provider(harness).interactions?.pending({ background: true }) ?? [];
  }

  private async pendingQuestionnaire(record: WorkbenchSubagentRelationship) {
    return (await this.pendingQuestionnaires(record.harness)).find((entry) => entry.threadId === record.threadId) ?? null;
  }

  private async wait(params: Record<string, unknown>) {
    const records = await this.ownedRecords(params);
    await this.assertUnlocked(records[0]!.projectId, records);
    const waitId = requiredString(params, "waitId");
    if (!this.active) throw new Error("Subagent wait cancelled for runtime reload.");
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
          if (controller.signal.aborted) throw controller.signal.reason;
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
        if (ready.entry.pinned) return { output: `Subagent ${ready.record.name} (${await this.publicThreadId(ready.record.threadId, ready.record.projectId)}) was locked by the user.` };
        const thread = await this.provider(ready.record.harness).threads.readLatest(ready.record.threadId);
        const pending = ready.entry.lifecycle.kind === "needsAttention" && ready.entry.lifecycle.reason === "pendingInput"
          ? await this.pendingQuestionnaire(ready.record)
          : null;
        return { output: renderSubagentWaitResultOutput({
          multiplexed: records.length > 1,
          name: ready.record.name,
          outcome: pending ? "needs-interaction" : "finished",
          output: pending ? renderSubagentQuestionnaireOutput(thread, pending.request) : renderSubagentTurnOutput(thread),
          threadId: await this.publicThreadId(ready.record.threadId, ready.record.projectId),
        }) };
      }
      while (true) {
        const pendingByScope = new Map<string, Promise<PendingQuestionnaireList["data"]>>();
        const states = await Promise.all(records.map(async (record) => {
          const scopeKey = `${record.harness}\0${record.cwd}`;
          let pendingPromise = pendingByScope.get(scopeKey);
          if (!pendingPromise) {
            pendingPromise = this.pendingQuestionnaires(record.harness);
            pendingByScope.set(scopeKey, pendingPromise);
          }
          const [thread, pending] = await Promise.all([
            this.provider(record.harness).threads.read(record.threadId, { background: true }),
            pendingPromise,
          ]);
          return { pending: pending.find((entry) => entry.threadId === record.threadId) ?? null, record, thread };
        }));
        const questionnaireState = states.find((state) => state.pending);
        if (questionnaireState?.pending) {
          const thread = await this.provider(questionnaireState.record.harness).threads.readLatest(questionnaireState.record.threadId);
          return { output: renderSubagentWaitResultOutput({
            multiplexed: records.length > 1,
            name: questionnaireState.record.name,
            outcome: "needs-interaction",
            output: renderSubagentQuestionnaireOutput(thread, questionnaireState.pending.request),
            threadId: await this.publicThreadId(questionnaireState.record.threadId, questionnaireState.record.projectId),
          }) };
        }
        const finishedState = states.find((state) => state.thread.status === "idle" || state.thread.status === "systemError");
        if (finishedState) {
          const thread = await this.provider(finishedState.record.harness).threads.readLatest(finishedState.record.threadId);
          if (thread.status === "active" || thread.status === "notLoaded") {
            await delay(POLL_INTERVAL_MS, controller.signal);
            continue;
          }
          return { output: renderSubagentWaitResultOutput({
            multiplexed: records.length > 1,
            name: finishedState.record.name,
            outcome: "finished",
            output: renderSubagentTurnOutput(thread),
            threadId: await this.publicThreadId(finishedState.record.threadId, finishedState.record.projectId),
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

  private async message(params: Record<string, unknown>) {
    if (params.parent === true) {
      return await this.messageParent(params);
    }
    const { caller, record } = await this.ownedRecord(params);
    await this.assertUnlocked(record.projectId, [record]);
    const message = requiredString(params, "message");
    const provider = this.provider(record.harness);
    const thread = await provider.threads.readLatest(record.threadId);
    const turn = currentTurn(thread);
    const pending = await this.pendingQuestionnaire(record);
    const input = {
      cwd: record.cwd, threadId: record.threadId,
      message: { message, senderName: PARENT_AGENT_NAME, senderThreadId: caller.callerThreadId },
    };
    if (turn?.status === "inProgress") {
      await provider.threads.messageAgent(input);
      if (pending) await provider.interactions!.respond({
        requestKey: pending.requestKey, response: createEmptySubagentQuestionnaireResponse(pending.request), threadId: record.threadId, turnId: pending.turnId,
        insertAfterItemId: null, insertAfterItemIndex: null,
      });
      return {};
    }
    await provider.threads.messageAgent({
      ...input,
      context: this.buildPromptContext(record.name, typeof params.workbenchOrigin === "string" ? params.workbenchOrigin : undefined),
    });
    return {};
  }

  private async messageParent(params: Record<string, unknown>) {
    const callerThreadId = this.readThreadId(params, "callerThreadId");
    const cwd = requiredString(params, "cwd");
    const requestedProject = await this.resolveProjectFromCwd(cwd, { endpointName: "Workbench subagent" });
    const relationships = await this.subagentStore.list({ projectId: requestedProject.project.id });
    const relationship = relationships.subagents.find(({ threadId }) => threadId === callerThreadId) ?? null;
    if (!relationship) {
      throw new Error("The current thread is not a Workbench subagent with a direct parent in this project.");
    }
    const caller = await this.resolveCaller(params, { knownHarness: relationship.harness, requestedProject });
    const parent = await this.resolveThreadHarness(
      relationship.parentThreadId,
      relationship.cwd,
      caller.project,
      "Workbench subagent parent",
    );
    await this.provider(parent.harness).threads.messageAgent({
      cwd: parent.thread.cwd, threadId: parent.thread.id,
      message: {
        message: requiredString(params, "message"), senderName: relationship.name,
        senderThreadId: relationship.threadId,
      },
    });
    return {};
  }

  private async stop(params: Record<string, unknown>) {
    const records = await this.ownedRecords(params);
    await this.assertUnlocked(records[0]!.projectId, records);
    for (const record of records) {
      const threads = this.provider(record.harness).threads;
      const turn = await threads.latestTurn(record.threadId);
      if (turn?.status === "inProgress") await threads.interrupt(record.threadId, turn.id, { preserveGoal: true });
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
