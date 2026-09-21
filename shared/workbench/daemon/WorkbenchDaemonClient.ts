/*
 * Exports:
 * - WorkbenchDaemonTransport: existing socket request port.
 * - WorkbenchDaemonRequestError: typed JSON-RPC failure with bounded domain data.
 * - default WorkbenchDaemonClient: create the browser daemon client.
 */
import type {
  WorkbenchDaemonGitArcMethod,
  WorkbenchDaemonMethod,
  WorkbenchDaemonParams,
  WorkbenchDaemonResult,
} from "./workbench-daemon-requests.ts";
import { WORKBENCH_GIT_ARC_ACTION_BY_METHOD } from "./workbench-daemon-requests.ts";
import { z } from "zod";
import { VoiceConfigurationSchema, VoiceSessionEventSchema, type VoiceSessionEvent } from "../voice/voice-session-contract";
import { WorkingTreeReadSchema, WorkingTreeDiffSchema, WorkingTreePreviewSchema, WorkingTreeResultSchema } from "../git/working-tree-contracts";
import { WorkbenchSandboxNetworkSettingsResponseSchema } from "../provider/provider-settings";
import {
  GitCheckpointCompareResultSchema,
  GitCheckpointProposalSchema,
} from "../git/checkpoint-contracts.ts";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  GitArcFailureSchema,
} from "../git/git-arc-failures.ts";
import reportClientSchemaError from "../report-client-schema-error.ts";
import { WorkbenchProjectsPayloadSchema } from "../project/project-state.ts";
import { WorkbenchComposerProfileSelectionSchema } from "../thread/thread-state.ts";
import { WorkbenchModelContextCapabilitySchema } from "../thread/thread-profile.ts";
import { WorkbenchThreadIdentityResolutionSchema } from "../thread/workbench-thread-identity.ts";
import { workbenchThreadActions } from "../thread/thread-actions.ts";
import { WorkbenchModelOptionSchema } from "../provider/provider-model.ts";
import { WorkbenchAccountLimitsSchema } from "../provider/provider-account.ts";
import { WorkbenchSearchResponseSchema } from "../search/workbench-search.ts";
import { WorkbenchStatsDetailedResponseSchema } from "../stats/workbench-stats-detail-contract.ts";
import {
  WORKBENCH_STATS_IMPORT_UPDATED_METHOD,
  WorkbenchStatsImportProgressSchema,
  WorkbenchStatsResponseSchema,
  type WorkbenchStatsImportProgress,
} from "../stats/workbench-stats-contract.ts";

export interface WorkbenchDaemonTransport {
  request<TResponse>(method: string, params: object): Promise<TResponse>;
  onNotification?(listener: (notification: { method: string; params: unknown }) => void): () => void;
  onReconnect?(listener: () => void): () => void;
  onDisconnect?(listener: () => void): () => void;
}

export class WorkbenchDaemonRequestError extends Error {
  constructor(message: string, readonly code: number, readonly data: object | null = null) {
    super(message);
    this.name = "WorkbenchDaemonRequestError";
  }
}

const recordSchema = z.object({}).passthrough();
const fileWriteSchema = z.union([
  z.object({ actualMtimeMs: z.number(), error: z.string(), expectedMtimeMs: z.number(), path: z.string() }).passthrough(),
  z.object({ changes: z.record(z.string(), recordSchema), mtimeMs: z.number(), path: z.string(), projectId: z.string(), updatedAt: z.string() }).passthrough(),
]);

function schemaFor(method: WorkbenchDaemonMethod): z.ZodType {
  if (method in workbenchThreadActions) {
    return workbenchThreadActions[method as keyof typeof workbenchThreadActions].result;
  }
  switch (method) {
    case "voice/configuration/read": return VoiceConfigurationSchema;
    case "voice/agents": return z.object({ data: z.array(z.object({
      name: z.string(), path: z.string(), description: z.string(), source: z.literal("library"), sourceLabel: z.string(),
    }).passthrough()) });
    case "voice/configuration/write":
    case "voice/prepare":
    case "voice/start":
    case "voice/audio":
    case "voice/finish":
    case "voice/cancel": return z.object({ ok: z.literal(true) }).strict();
    case "git/working-tree/read": return WorkingTreeReadSchema;
    case "git/working-tree/diff": return WorkingTreeDiffSchema;
    case "git/working-tree/preview": return WorkingTreePreviewSchema;
    case "git/working-tree/mutate": return WorkingTreeResultSchema;
    case "models/list": return z.object({ data: z.array(WorkbenchModelOptionSchema) });
    case "account/limits/read": return WorkbenchAccountLimitsSchema;
    case "models/context/read": return z.object({ data: z.array(WorkbenchModelContextCapabilitySchema) }).strict();
    case "sandbox-network/read":
    case "sandbox-network/update": return WorkbenchSandboxNetworkSettingsResponseSchema;
    case "project/catalog/read": return WorkbenchProjectsPayloadSchema;
    case "thread/identity/resolve": return z.object({ data: WorkbenchThreadIdentityResolutionSchema.nullable() }).strict();
    case "project/file/read": return z.object({
      content: z.string(), headContent: z.string().nullable(), mtimeMs: z.number(), path: z.string(), projectId: z.string(), updatedAt: z.string(),
    }).strict();
    case "project/file/reset":
    case "project/file/save": return fileWriteSchema;
    case "search/query": return WorkbenchSearchResponseSchema;
    case "stats/read": return WorkbenchStatsResponseSchema;
    case "stats/read/detailed":
    case "stats/read/efficiency":
    case "stats/read/efficiency/v2": return WorkbenchStatsDetailedResponseSchema;
    case "stats/import/start": return WorkbenchStatsImportProgressSchema;
    case "stats/rate-limits/refresh": return z.object({ ok: z.literal(true) }).strict();
    case "local-capabilities/read":
    case "local-capabilities/update": return z.object({
      localCapabilities: z.object({ browseRawCommandsEnabled: z.boolean() }).strict(),
    }).strict();
    case "agents/list": return z.object({ data: z.array(recordSchema) }).strict();
    case "agents/read": return z.object({ providerGlobalDuplicate: z.boolean(), data: recordSchema }).strict();
    case "skills/read": return z.object({
      data: z.array(recordSchema), instructionPacks: z.array(recordSchema), instructions: z.string(),
    }).strict();
    case "native/file/open":
    case "native/file/reveal": return z.object({ ok: z.literal(true), path: z.string(), projectId: z.string().nullable() }).passthrough();
    case "native/file/link-roots": return z.object({ roots: z.array(recordSchema) }).strict();
    case "questionnaire/respond": return z.object({
      ok: z.literal(true),
      route: z.enum(["admitted", "live", "provider"]),
      warning: z.string().optional(),
    }).strict();
    case "browse/sessions/read": return z.object({ sessions: z.array(recordSchema) }).passthrough();
    case "browse/sessions/forget":
    case "browse/sessions/stop": return recordSchema;
    case "profiles/delete":
    case "profiles/read":
    case "profiles/upsert": return z.object({ profiles: z.array(z.object({
      lastUsedAt: z.number().int().nonnegative().nullable().default(null),
    }).passthrough()) }).passthrough();
    case "profiles/target/read": return z.object({ selection: WorkbenchComposerProfileSelectionSchema.nullable() }).strict();
    case "profiles/target/set": return z.object({ ok: z.literal(true) }).strict();
    case "git/arc/compare": return GitCheckpointCompareResultSchema;
    case "git/arc/proposal/commit":
    case "git/arc/proposal/read": return GitCheckpointProposalSchema;
    case "git/arc/diff-artifact/read": return z.string();
    case "git/arc/release":
    case "git/arc/remove":
    case "git/arc/restore": return z.object({ ok: z.literal(true) }).strict();
    default: throw new Error(`No response schema is registered for ${method}.`);
  }
}

class WorkbenchDaemonClient {
  constructor(private readonly transport: WorkbenchDaemonTransport) {}

  readonly voice = {
    configuration: {
      read: () => this.request("voice/configuration/read", {}),
      write: (params: WorkbenchDaemonParams<"voice/configuration/write">) => this.request("voice/configuration/write", params),
    },
    agents: () => this.request("voice/agents", {}),
    prepare: () => this.request("voice/prepare", {}),
    start: (params: WorkbenchDaemonParams<"voice/start">) => this.request("voice/start", params),
    audio: (params: WorkbenchDaemonParams<"voice/audio">) => this.request("voice/audio", params),
    finish: (sessionId: string) => this.request("voice/finish", { sessionId }),
    cancel: (sessionId: string) => this.request("voice/cancel", { sessionId }),
  };

  onVoiceEvent(listener: (event: VoiceSessionEvent) => void) {
    return this.transport.onNotification?.(notification => {
      if (notification.method !== "voice/event") return;
      const parsed = VoiceSessionEventSchema.safeParse(notification.params);
      if (!parsed.success) {
        reportClientSchemaError("Rejected voice event", parsed.error);
        return;
      }
      listener(parsed.data);
    }) ?? (() => undefined);
  }

  onDisconnect(listener: () => void) {
    return this.transport.onDisconnect?.(listener) ?? (() => undefined);
  }

  readonly models = {
    list: (provider: string) => this.request("models/list", { provider }),
    context: (params: WorkbenchDaemonParams<"models/context/read">) => this.request("models/context/read", params),
  };

  readonly account = {
    limits: (provider: string) => this.request("account/limits/read", { provider }),
  };

  readonly threads = {
    resolveIdentity: (params: WorkbenchDaemonParams<"thread/identity/resolve">) => this.request("thread/identity/resolve", params),
    history: {
      questionnaires: (params: WorkbenchDaemonParams<"thread/questionnaires/read">) => this.request("thread/questionnaires/read", params),
      steers: (params: WorkbenchDaemonParams<"thread/steers/read">) => this.request("thread/steers/read", params),
      browse: (params: WorkbenchDaemonParams<"thread/browse/read">) => this.request("thread/browse/read", params),
    },
    questionnaire: {
      respond: (params: WorkbenchDaemonParams<"questionnaire/respond">) => this.request("questionnaire/respond", params),
    },
    create: (params: WorkbenchDaemonParams<"thread/create">) => this.request("thread/create", params),
    read: (params: WorkbenchDaemonParams<"thread/metadata/read">) => this.request("thread/metadata/read", params),
    page: (params: WorkbenchDaemonParams<"thread/page/read">) => this.request("thread/page/read", params),
    reconcile: (params: WorkbenchDaemonParams<"thread/reconcile">) => this.request("thread/reconcile", params),
    message: (params: WorkbenchDaemonParams<"thread/message/submit">) => this.request("thread/message/submit", params),
    title: (params: WorkbenchDaemonParams<"thread/title/set">) => this.request("thread/title/set", params),
    compact: (params: WorkbenchDaemonParams<"thread/compact">) => this.request("thread/compact", params),
    deleteProvider: (params: WorkbenchDaemonParams<"thread/provider/delete">) => this.request("thread/provider/delete", params),
    stop: (params: WorkbenchDaemonParams<"thread/stop">) => this.request("thread/stop", params),
    goal: {
      read: (params: WorkbenchDaemonParams<"thread/goal/read">) => this.request("thread/goal/read", params),
      update: (params: WorkbenchDaemonParams<"thread/goal/update">) => this.request("thread/goal/update", params),
      clear: (params: WorkbenchDaemonParams<"thread/goal/remove">) => this.request("thread/goal/remove", params),
    },
  };

  readonly questionnaires = {
    pending: () => this.request("questionnaires/pending/read", {}),
  };

  readonly projects = {
    catalog: () => this.request("project/catalog/read", {}),
    files: {
      read: (params: WorkbenchDaemonParams<"project/file/read">) => this.request("project/file/read", params),
      reset: (params: WorkbenchDaemonParams<"project/file/reset">) => this.request("project/file/reset", params),
      save: (params: WorkbenchDaemonParams<"project/file/save">) => this.request("project/file/save", params),
    },
  };

  readonly profiles = {
    read: () => this.request("profiles/read", {}),
    upsert: (params: WorkbenchDaemonParams<"profiles/upsert">) => this.request("profiles/upsert", params),
    delete: (params: WorkbenchDaemonParams<"profiles/delete">) => this.request("profiles/delete", params),
    target: {
      read: (params: WorkbenchDaemonParams<"profiles/target/read">) => this.request("profiles/target/read", params),
      set: (params: WorkbenchDaemonParams<"profiles/target/set">) => this.request("profiles/target/set", params),
    },
  };

  readonly agents = {
    list: (params: WorkbenchDaemonParams<"agents/list">) => this.request("agents/list", params),
    read: (params: WorkbenchDaemonParams<"agents/read">) => this.request("agents/read", params),
  };

  readonly skills = {
    read: (params: WorkbenchDaemonParams<"skills/read">) => this.request("skills/read", params),
  };

  readonly search = {
    query: (params: WorkbenchDaemonParams<"search/query">) => this.request("search/query", params),
  };

  readonly localCapabilities = {
    read: () => this.request("local-capabilities/read", {}),
    update: (params: WorkbenchDaemonParams<"local-capabilities/update">) => this.request("local-capabilities/update", params),
  };

  readonly sandboxNetwork = {
    read: (params: WorkbenchDaemonParams<"sandbox-network/read">) => this.request("sandbox-network/read", params),
    update: (params: WorkbenchDaemonParams<"sandbox-network/update">) => this.request("sandbox-network/update", params),
  };

  readonly nativeFiles = {
    open: (params: WorkbenchDaemonParams<"native/file/open">) => this.request("native/file/open", params),
    reveal: (params: WorkbenchDaemonParams<"native/file/reveal">) => this.request("native/file/reveal", params),
    linkRoots: (params: WorkbenchDaemonParams<"native/file/link-roots">) => this.request("native/file/link-roots", params),
  };

  readonly browse = {
    sessions: {
      read: (params: WorkbenchDaemonParams<"browse/sessions/read">) => this.request("browse/sessions/read", params),
      forget: (params: WorkbenchDaemonParams<"browse/sessions/forget">) => this.request("browse/sessions/forget", params),
      stop: (params: WorkbenchDaemonParams<"browse/sessions/stop">) => this.request("browse/sessions/stop", params),
    },
  };

  readonly stats = {
    read: (params: WorkbenchDaemonParams<"stats/read">) => this.request("stats/read", params),
    detailed: (params: WorkbenchDaemonParams<"stats/read/detailed">) => this.request("stats/read/detailed", params),
    efficiency: (params: WorkbenchDaemonParams<"stats/read/efficiency">) => this.request("stats/read/efficiency", params),
    efficiencyV2: (params: WorkbenchDaemonParams<"stats/read/efficiency/v2">) => this.request("stats/read/efficiency/v2", params),
    startImport: () => this.request("stats/import/start", {}),
    refreshRateLimits: () => this.request("stats/rate-limits/refresh", {}),
  };

  readonly git = {
    workingTree: {
      read: (params: WorkbenchDaemonParams<"git/working-tree/read">) => this.request("git/working-tree/read", params),
      diff: (params: WorkbenchDaemonParams<"git/working-tree/diff">) => this.request("git/working-tree/diff", params),
      preview: (params: WorkbenchDaemonParams<"git/working-tree/preview">) => this.request("git/working-tree/preview", params),
      mutate: (params: WorkbenchDaemonParams<"git/working-tree/mutate">) => this.request("git/working-tree/mutate", params),
    },
    arc: {
      compare: (params: WorkbenchDaemonParams<"git/arc/compare">) => this.requestGitArc("git/arc/compare", params),
      release: (params: WorkbenchDaemonParams<"git/arc/release">) => this.requestGitArc("git/arc/release", params),
      remove: (params: WorkbenchDaemonParams<"git/arc/remove">) => this.requestGitArc("git/arc/remove", params),
      restore: (params: WorkbenchDaemonParams<"git/arc/restore">) => this.requestGitArc("git/arc/restore", params),
      diffArtifact: (params: WorkbenchDaemonParams<"git/arc/diff-artifact/read">) => this.requestGitArc("git/arc/diff-artifact/read", params),
      proposal: {
        read: (params: WorkbenchDaemonParams<"git/arc/proposal/read">) => this.requestGitArc("git/arc/proposal/read", params),
        commit: (params: WorkbenchDaemonParams<"git/arc/proposal/commit">) => this.requestGitArc("git/arc/proposal/commit", params),
      },
    },
  };

  onReconnect(listener: () => void) {
    return this.transport.onReconnect?.(listener) ?? (() => undefined);
  }

  onStatsImportProgress(listener: (progress: WorkbenchStatsImportProgress) => void) {
    return this.transport.onNotification?.((notification) => {
      if (notification.method !== WORKBENCH_STATS_IMPORT_UPDATED_METHOD) return;
      const parsed = WorkbenchStatsImportProgressSchema.safeParse(notification.params);
      if (!parsed.success) {
        reportClientSchemaError("Rejected Workbench stats import progress", parsed.error);
        return;
      }
      listener(parsed.data);
    }) ?? (() => undefined);
  }

  private async request<TMethod extends WorkbenchDaemonMethod>(
    method: TMethod,
    params: WorkbenchDaemonParams<TMethod>,
  ): Promise<WorkbenchDaemonResult<TMethod>> {
    const result = await this.transport.request<WorkbenchDaemonResult<TMethod>>(method, params);
    const parsed = schemaFor(method).safeParse(result);
    if (!parsed.success) {
      reportClientSchemaError(`Rejected ${method} response`, parsed.error);
      throw new Error(`The ${method} response was invalid.`);
    }
    if (method === "profiles/read" || method === "profiles/upsert" || method === "profiles/delete") {
      return parsed.data as WorkbenchDaemonResult<TMethod>;
    }
    return result;
  }

  private async requestGitArc<TMethod extends WorkbenchDaemonGitArcMethod>(
    method: TMethod,
    params: WorkbenchDaemonParams<TMethod>,
  ): Promise<WorkbenchDaemonResult<TMethod>> {
    try {
      return await this.request(method, params);
    } catch (error) {
      const errorData = error instanceof WorkbenchDaemonRequestError
        ? error.data as { gitArcFailure?: object } | null
        : null;
      const failure = error instanceof WorkbenchDaemonRequestError
        ? GitArcFailureSchema.safeParse(errorData?.gitArcFailure)
        : null;
      throw new GitArcFailureException(failure?.success
        ? failure.data
        : createGitArcOperationRejected(
          WORKBENCH_GIT_ARC_ACTION_BY_METHOD[method],
          error instanceof Error ? error.message : "Git arc request failed.",
        ));
    }
  }
}

export default WorkbenchDaemonClient;
