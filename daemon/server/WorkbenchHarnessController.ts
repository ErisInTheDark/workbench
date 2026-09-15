/*
 * Exports:
 * - WorkbenchHarnessRuntimePort: stable bridge operations supplied to reloadable harness registrations.
 * - WorkbenchHarnessAdapter: exhaustive provider capability registration.
 * - default WorkbenchHarnessController: own browser, server, Browse, and recovery routing.
 * - WorkbenchHarnessControllerOptions: turn admission and public identity boundary.
 */
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import type { WorkbenchThreadContextReadResponse } from "workbench-shared/types";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadTurnsListResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadTurnsListResponse";
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsHydrationResult } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkbenchStatsUsageImportCandidate } from "./database/stats/WorkbenchStatsImportRepository";
import type { BridgeClient, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { WorkbenchTurnRecoveryPort } from "./WorkbenchTurnRecoveryController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import { mapWorkbenchProviderRequest, mapNativeProviderResponse } from "./thread-identity-workbench-mapping";
import { admitProviderNotifications, admitProviderThreads } from "./thread-identity-provider-mapping";
import type { WorkbenchThreadIdentityLookup } from "./database/thread-identity/workbench-thread-identity-types";
import { NativeThreadIdSchema, ThreadReferenceSchema, type NativeThreadId, type NativeTurnId, type ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchTurnIdentityLookup } from "./database/thread-identity/workbench-thread-identity-types";

export interface WorkbenchHarnessRuntimePort {
  handleBrowserMessage(message: JsonRpcRequest, client: BridgeClient): Promise<void>;
  request(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse>;
  readThread(threadId: NativeThreadId): Promise<Pick<WorkbenchThreadContextReadResponse, "thread">>;
  steerTurn(threadId: NativeThreadId, expectedTurnId: NativeTurnId, input: UserInput[]): Promise<string | null>;
  recoverInterruptedTurn?: WorkbenchTurnRecoveryPort;
  readLoadedThreads?: () => readonly Thread[];
}

type WorkbenchHarnessRecoveryCapability =
  | { kind: "none" }
  | {
      observeNotification(notification: JsonRpcNotification): void;
      observeRequest(request: JsonRpcRequest): void;
      kind: "observe";
    }
  | {
      kind: "turn";
      observeNotification(notification: JsonRpcNotification): void;
      observeRequest(request: JsonRpcRequest): void;
      recoverAvailable?(signal?: AbortSignal): Promise<void>;
      resumeThread(threadId: NativeThreadId): Promise<void>;
    };

export interface WorkbenchHarnessAdapter {
  browse: Pick<WorkbenchHarnessRuntimePort, "readThread" | "steerTurn">;
  browser: Pick<WorkbenchHarnessRuntimePort, "handleBrowserMessage">;
  id: WorkbenchHarness;
  internal: Pick<WorkbenchHarnessRuntimePort, "request">;
  recovery: WorkbenchHarnessRecoveryCapability;
  serverMethods: readonly string[];
  usageHydration?: (candidate: WorkbenchStatsUsageImportCandidate) => Promise<WorkbenchStatsHydrationResult>;
  readLoadedThreads?: WorkbenchHarnessRuntimePort["readLoadedThreads"];
}

export interface WorkbenchHarnessControllerOptions {
  admitTurnStart?: () => void;
  identities?: WorkbenchThreadIdentityController;
  itemIdentities?: WorkbenchTranscriptIdentityController;
  resolveProject?: (cwd: string) => Promise<{ projectId: ProjectId; projectRoot: string }>;
}

function requireNonEmptyUniqueValues(values: readonly string[], label: string) {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) throw new Error(`${label} cannot contain an empty value.`);
  if (normalized.some((value, index) => value !== values[index])) throw new Error(`${label} must contain canonical values without surrounding whitespace.`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} cannot contain duplicate values.`);
  return normalized;
}

export default class WorkbenchHarnessController {
  private readonly adapters: readonly WorkbenchHarnessAdapter[];
  private readonly adaptersById: ReadonlyMap<WorkbenchHarness, WorkbenchHarnessAdapter>;
  private readonly admitTurnStart: () => void;
  private readonly identities: WorkbenchHarnessControllerOptions["identities"];
  private readonly itemIdentities: WorkbenchHarnessControllerOptions["itemIdentities"];
  private readonly resolveProject: WorkbenchHarnessControllerOptions["resolveProject"];

  constructor(adapters: readonly WorkbenchHarnessAdapter[], options: WorkbenchHarnessControllerOptions = {}) {
    if (!adapters.length) throw new Error("At least one Workbench harness adapter is required.");
    const adaptersById = new Map<WorkbenchHarness, WorkbenchHarnessAdapter>();
    for (const adapter of adapters) {
      if (adaptersById.has(adapter.id)) throw new Error(`Workbench harness ${adapter.id} is registered more than once.`);
      requireNonEmptyUniqueValues(adapter.serverMethods, `Workbench harness ${adapter.id} server methods`);
      adaptersById.set(adapter.id, adapter);
    }
    if (!adaptersById.has("codex")) throw new Error("The default Codex harness adapter is required.");
    this.adapters = [...adapters];
    this.adaptersById = adaptersById;
    this.admitTurnStart = options.admitTurnStart ?? (() => undefined);
    this.identities = options.identities;
    this.itemIdentities = options.itemIdentities;
    this.resolveProject = options.resolveProject;
  }

  async admitThreads(harness: WorkbenchHarness, threads: readonly Thread[]) {
    if (!this.identities || !this.itemIdentities || !this.resolveProject) throw new Error("Provider identity admission is unavailable.");
    const inputs = await Promise.all(threads.map(async (thread) => ({
      thread, metadata: {
        ...await this.resolveProject!(thread.cwd),
        native: { harness, nativeLocation: thread.cwd, nativeThreadId: NativeThreadIdSchema.parse(thread.id) },
        title: thread.name ?? "", createdAt: thread.createdAt * 1_000,
        updatedAt: thread.updatedAt * 1_000, activityAt: thread.updatedAt * 1_000,
      },
    })));
    await admitProviderThreads({ threads: this.identities, items: this.itemIdentities }, inputs);
  }

  async admitNotifications(harness: WorkbenchHarness, threadId: NativeThreadId, notifications: readonly JsonRpcNotification[]) {
    if (!this.identities || !this.itemIdentities) throw new Error("Provider identity admission is unavailable.");
    const native = this.identities.knownNativeBinding(harness, threadId);
    await admitProviderNotifications({ threads: this.identities, items: this.itemIdentities }, native, notifications as ServerNotification[]);
  }

  listHarnesses() {
    return this.adapters.map(({ id }) => id);
  }

  async restoreLoadedIdentities() {
    for (const adapter of this.adapters) {
      const threads = adapter.readLoadedThreads?.() ?? [];
      if (threads.length) await this.admitThreads(adapter.id, threads);
    }
  }

  listUsageHydrationHarnesses() {
    return this.adapters.filter(({ usageHydration }) => Boolean(usageHydration)).map(({ id }) => id);
  }

  async hydrateUsage(candidate: WorkbenchStatsUsageImportCandidate) {
    const hydrate = this.getAdapter(candidate.harness).usageHydration;
    if (!hydrate) throw new Error(`Usage hydration is unavailable for ${candidate.harness} threads.`);
    return await hydrate(candidate);
  }

  resolveHarness(value: unknown, options: { defaultToCodex?: boolean } = {}) {
    if ((value === undefined || value === null || value === "") && options.defaultToCodex) return "codex" as const;
    if (!ProviderKeySchema.safeParse(value).success || !this.adaptersById.has(value as WorkbenchHarness)) {
      throw new Error(`Unknown Workbench harness: ${typeof value === "string" && value ? value : "missing"}.`);
    }
    return value as WorkbenchHarness;
  }

  async handleBrowserMessage(value: unknown, message: JsonRpcRequest, client: BridgeClient) {
    const resolved = await this.resolvePublicRequest(value, message);
    await this.handleNativeBrowserMessage(resolved.harness, resolved.request, client);
  }

  async handleNativeBrowserMessage(harness: WorkbenchHarness, message: JsonRpcRequest, client: BridgeClient) {
    const adapter = this.getAdapter(harness);
    if (message.method === "turn/start") this.admitTurnStart();
    if (adapter.recovery.kind !== "none" && "id" in message) adapter.recovery.observeRequest(message);
    await adapter.browser.handleBrowserMessage(message, client);
  }

  async request(harness: WorkbenchHarness, request: JsonRpcRequest) {
    const adapter = this.getAdapter(harness);
    if (request.method === "turn/start") this.admitTurnStart();
    if (adapter.recovery.kind !== "none") adapter.recovery.observeRequest(request);
    return await adapter.internal.request(request);
  }

  async resolvePublicRequest(value: unknown, request: JsonRpcRequest) {
    const harness = this.resolveHarness(value, { defaultToCodex: true });
    const params = request.params;
    if (this.identities && params && typeof params === "object" && "threadId" in params
      && typeof params.threadId === "string") {
      await this.resolveThreadIdentity({ threadId: ThreadReferenceSchema.parse(params.threadId), harness });
    }
    return this.identities ? mapWorkbenchProviderRequest(this.identities, harness, request) : { harness, request };
  }

  async resolveThreadIdentity(input: WorkbenchThreadIdentityLookup) {
    if (!this.identities) throw new Error("Thread identity resolution is unavailable.");
    const known = await this.identities.resolve(input);
    if (known) return known;
    const harness = this.resolveHarness(input.harness, { defaultToCodex: true });
    const response = await this.request(harness, {
      method: "thread/read", params: { threadId: input.threadId, includeTurns: false },
    });
    if (response.error) throw new Error(response.error.message);
    const thread = (response.result as ThreadReadResponse | undefined)?.thread;
    if (!thread || thread.id !== input.threadId) throw new Error("Provider metadata returned a different thread.");
    await this.admitThreads(harness, [thread]);
    return await this.identities.resolve(input);
  }

  async resolveTurnIdentity(input: WorkbenchThreadIdentityLookup & Pick<WorkbenchTurnIdentityLookup, "turnId">) {
    if (!this.identities || !this.itemIdentities) throw new Error("Turn identity resolution is unavailable.");
    const thread = await this.resolveThreadIdentity(input);
    if (!thread) throw new Error("Thread metadata is unavailable for turn identity resolution.");
    const known = await this.identities.resolveTurn({ threadId: thread.threadId, turnId: input.turnId });
    if (known) return known;
    const harness = this.resolveHarness(input.harness, { defaultToCodex: true });
    const native = thread.bindings.find((binding) => binding.harness === harness && binding.nativeThreadId === input.threadId)
      ?? thread.bindings.find((binding) => binding.harness === harness);
    if (!native) throw new Error("Turn identity has no admitted native thread.");
    if (harness !== "codex") throw new Error("Provider turn metadata is unavailable for public projection.");
    let cursor: string | null = null;
    do {
      const response = await this.request(harness, {
        method: "thread/turns/list",
        params: {
          threadId: native.nativeThreadId, cwd: native.nativeLocation,
          itemsView: "notLoaded", limit: 100, sortDirection: "asc", cursor,
        },
      });
      if (response.error) throw new Error(response.error.message);
      const result = response.result as ThreadTurnsListResponse | undefined;
      if (!result || !Array.isArray(result.data)) throw new Error("Provider turn metadata response is invalid.");
      await admitProviderNotifications({ threads: this.identities, items: this.itemIdentities }, native, result.data.map((turn) => ({
        method: "turn/started" as const, params: { threadId: native.nativeThreadId, turn },
      })));
      const admitted = await this.identities.resolveTurn({ threadId: thread.threadId, turnId: input.turnId });
      if (admitted) return admitted;
      if (result.nextCursor !== null && result.nextCursor === cursor) throw new Error("Provider turn metadata cursor did not advance.");
      cursor = result.nextCursor;
    } while (cursor);
    throw new Error("Referenced turn is absent from the provider metadata catalog.");
  }

  async requestServer(harnessValue: unknown, request: JsonRpcRequest) {
    const harness = this.resolveHarness(harnessValue);
    const adapter = this.getAdapter(harness);
    const method = request.method?.trim() ?? "";
    if (!method || !adapter.serverMethods.includes(method)) {
      throw new Error(`Workbench bridge method ${method || "missing"} is not allowed for ${harness}.`);
    }
    const resolved = await this.resolvePublicRequest(harness, { ...request, method });
    const response = await this.request(resolved.harness, resolved.request);
    return this.identities && this.itemIdentities
      ? mapNativeProviderResponse({ threads: this.identities, items: this.itemIdentities }, resolved.harness, resolved.request, response)
      : response;
  }

  async readThread(harness: WorkbenchHarness, threadId: NativeThreadId) {
    return await this.getAdapter(harness).browse.readThread(threadId);
  }

  async steerTurn(harness: WorkbenchHarness, threadId: NativeThreadId, expectedTurnId: NativeTurnId, input: UserInput[]) {
    return await this.getAdapter(harness).browse.steerTurn(threadId, expectedTurnId, input);
  }

  observeNotification(harness: WorkbenchHarness, notification: JsonRpcNotification) {
    const recovery = this.getAdapter(harness).recovery;
    if (recovery.kind !== "none") recovery.observeNotification(notification);
  }

  async recoverAvailable(harness: WorkbenchHarness, signal?: AbortSignal) {
    const recovery = this.getAdapter(harness).recovery;
    if (recovery.kind === "turn") await recovery.recoverAvailable?.(signal);
  }

  async resumeThread(harness: WorkbenchHarness, threadId: NativeThreadId) {
    const recovery = this.getAdapter(harness).recovery;
    if (recovery.kind !== "turn") throw new Error(`Manual thread resume is unavailable for ${harness} threads.`);
    await recovery.resumeThread(threadId);
  }

  private getAdapter(harness: WorkbenchHarness) {
    const adapter = this.adaptersById.get(harness);
    if (!adapter) throw new Error(`Unknown Workbench harness: ${harness}.`);
    return adapter;
  }
}
