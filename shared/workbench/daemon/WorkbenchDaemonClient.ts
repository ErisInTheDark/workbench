/*
 * Exports:
 * - WorkbenchDaemonRequestOptions: per-request cancellation.
 * - WorkbenchDaemonTransport: existing socket request port.
 * - WorkbenchDaemonRequestError: typed JSON-RPC failure with bounded domain data.
 * - default WorkbenchDaemonClient: create the browser daemon client: a typed `request` for any daemon method, validated against its registered
 *   response schema, plus grouped convenience methods.
 */
import type {
  WorkbenchDaemonGitArcMethod,
  WorkbenchDaemonMethod,
  WorkbenchDaemonParams,
  WorkbenchDaemonResult,
} from "./workbench-daemon-requests.ts";
import {
  getWorkbenchDaemonResultSchema, isWorkbenchDaemonResultParsed, WORKBENCH_GIT_ARC_ACTION_BY_METHOD,
} from "./workbench-daemon-requests.ts";
import { VoiceSessionEventSchema, type VoiceSessionEvent } from "../voice/voice-session-contract";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  GitArcFailureSchema,
} from "../git/git-arc-failures.ts";
import reportClientSchemaError from "../report-client-schema-error.ts";
import type { ProviderRuntimeKey } from "../provider/provider-runtime.ts";
import {
  WORKBENCH_STATS_IMPORT_UPDATED_METHOD,
  WorkbenchStatsImportProgressSchema,
  type WorkbenchStatsImportProgress,
} from "../stats/workbench-stats-contract.ts";

export interface WorkbenchDaemonRequestOptions {
  /** Aborting cancels the request upstream where the transport supports it. */
  signal?: AbortSignal;
}

export interface WorkbenchDaemonTransport {
  request<TResponse>(method: string, params: object, options?: WorkbenchDaemonRequestOptions): Promise<TResponse>;
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

class WorkbenchDaemonClient {
  constructor(private readonly transport: WorkbenchDaemonTransport) {}

  readonly installationUpdate = {
    pull: () => this.request("installation/update/pull", {}),
    dismissFailure: () => this.request("installation/update/failure/dismiss", {}),
  };

  readonly installationRecord = {
    read: () => this.request("installation/record/read", {}),
    adopt: () => this.request("installation/record/adopt", {}),
  };

  readonly providerRuntimes = {
    read: () => this.request("provider/runtime/read", {}),
    install: (provider: ProviderRuntimeKey) => this.request("provider/runtime/install", { provider }),
  };

  readonly providerAccounts = {
    read: (provider: string) => this.request("provider/account/read", { provider }),
    start: (params: WorkbenchDaemonParams<"provider/account/sign-in/start">) => this.request("provider/account/sign-in/start", params),
    submitCode: (params: WorkbenchDaemonParams<"provider/account/sign-in/code">) => this.request("provider/account/sign-in/code", params),
    wait: (params: WorkbenchDaemonParams<"provider/account/sign-in/wait">) => this.request("provider/account/sign-in/wait", params),
    cancel: (params: WorkbenchDaemonParams<"provider/account/sign-in/cancel">) => this.request("provider/account/sign-in/cancel", params),
    signOut: (params: WorkbenchDaemonParams<"provider/account/sign-out">) => this.request("provider/account/sign-out", params),
  };

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
      approvals: (params: WorkbenchDaemonParams<"thread/approvals/read">) => this.request("thread/approvals/read", params),
      gitCommits: (params: WorkbenchDaemonParams<"thread/git-commits/read">) => this.request("thread/git-commits/read", params),
      gitCommitRefs: (params: WorkbenchDaemonParams<"thread/git-commit-refs/read">) => this.request("thread/git-commit-refs/read", params),
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
    interrupt: (params: WorkbenchDaemonParams<"thread/interrupt">) => this.request("thread/interrupt", params),
    steer: {
      resend: (params: WorkbenchDaemonParams<"thread/steer/resend">) => this.request("thread/steer/resend", params),
      dismiss: (params: WorkbenchDaemonParams<"thread/steer/dismiss">) => this.request("thread/steer/dismiss", params),
    },
    call: {
      stop: (params: WorkbenchDaemonParams<"thread/call/stop">) => this.request("thread/call/stop", params),
    },
    shell: {
      start: (params: WorkbenchDaemonParams<"thread/shell/start">) => this.request("thread/shell/start", params),
    },
    goal: {
      set: (params: WorkbenchDaemonParams<"thread/goal/set">) => this.request("thread/goal/set", params),
      clear: (params: WorkbenchDaemonParams<"thread/goal/clear">) => this.request("thread/goal/clear", params),
    },
    todo: {
      add: (params: WorkbenchDaemonParams<"thread/todo/add">) => this.request("thread/todo/add", params),
      remove: (params: WorkbenchDaemonParams<"thread/todo/remove">) => this.request("thread/todo/remove", params),
      setRequired: (params: WorkbenchDaemonParams<"thread/todo/required/set">) => this.request("thread/todo/required/set", params),
      setText: (params: WorkbenchDaemonParams<"thread/todo/text/set">) => this.request("thread/todo/text/set", params),
    },
    addressedFeedback: {
      detach: (params: WorkbenchDaemonParams<"thread/feedback/addressed/detach">) => this.request("thread/feedback/addressed/detach", params),
    },
    vis: {
      end: (params: WorkbenchDaemonParams<"thread/vis/end">) => this.request("thread/vis/end", params),
      control: (params: WorkbenchDaemonParams<"thread/vis/control">) => this.request("thread/vis/control", params),
    },
    skills: {
      read: (params: WorkbenchDaemonParams<"thread/skills/read">) => this.request("thread/skills/read", params),
      deactivate: (params: WorkbenchDaemonParams<"thread/skills/deactivate">) => this.request("thread/skills/deactivate", params),
    },
  };

  readonly questionnaires = {
    pending: () => this.request("questionnaires/pending/read", {}),
  };

  readonly projects = {
    refresh: (params: WorkbenchDaemonParams<"project/tree/refresh">) => this.request("project/tree/refresh", params),
    deleteFile: (params: WorkbenchDaemonParams<"project/file/delete">) => this.request("project/file/delete", params),
    catalog: () => this.request("project/catalog/read", {}),
    fileIndex: (params: WorkbenchDaemonParams<"project/file-index/read">) =>
      this.request("project/file-index/read", params),
    locations: () => this.request("project/locations/read", {}),
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

  readonly virtualRepos = {
    /** Probes the selected daemon again, so it doubles as the settings recheck. */
    availability: () => this.request("repo/runtime/read", {}),
  };

  readonly localCapabilities = {
    read: () => this.request("local-capabilities/read", {}),
    update: (params: WorkbenchDaemonParams<"local-capabilities/update">) => this.request("local-capabilities/update", params),
  };
  readonly threadAutoCompact = {
    read: () => this.request("thread-auto-compact/read", {}),
    update: (params: WorkbenchDaemonParams<"thread-auto-compact/update">) => this.request("thread-auto-compact/update", params),
  };

  readonly sandboxNetwork = {
    read: (params: WorkbenchDaemonParams<"sandbox-network/read">) => this.request("sandbox-network/read", params),
    update: (params: WorkbenchDaemonParams<"sandbox-network/update">) => this.request("sandbox-network/update", params),
  };

  readonly launches = {
    create: (params: WorkbenchDaemonParams<"thread/launch">) => this.request("thread/launch", params),
    read: (params: WorkbenchDaemonParams<"thread/launch/read">) => this.request("thread/launch/read", params),
  };

  readonly presentationExport = {
    manifest: (params: WorkbenchDaemonParams<"thread/presentation/manifest/read">) =>
      this.request("thread/presentation/manifest/read", params),
    project: (params: WorkbenchDaemonParams<"thread/presentation/export">) =>
      this.request("thread/presentation/export", params),
    attachment: (params: WorkbenchDaemonParams<"thread/presentation/attachment/read">) =>
      this.request("thread/presentation/attachment/read", params),
  };

  readonly commandApprovals = {
    read: (params: WorkbenchDaemonParams<"command-approvals/read">) => this.request("command-approvals/read", params),
    remove: (params: WorkbenchDaemonParams<"command-approvals/remove">) => this.request("command-approvals/remove", params),
    patch: (params: WorkbenchDaemonParams<"command-approvals/patch">) => this.request("command-approvals/patch", params),
  };

  readonly approvalReview = {
    read: () => this.request("approval-review/read", {}),
    update: (params: WorkbenchDaemonParams<"approval-review/update">) => this.request("approval-review/update", params),
  };

  readonly mcpServers = {
    read: (params: WorkbenchDaemonParams<"mcp-servers/read"> = {}) => this.request("mcp-servers/read", params),
    update: (params: WorkbenchDaemonParams<"mcp-servers/update">) => this.request("mcp-servers/update", params),
    env: {
      read: (params: WorkbenchDaemonParams<"mcp-servers/env/read">) => this.request("mcp-servers/env/read", params),
      update: (params: WorkbenchDaemonParams<"mcp-servers/env/update">) => this.request("mcp-servers/env/update", params),
    },
    startSignIn: (params: WorkbenchDaemonParams<"mcp-servers/sign-in/start">) => this.request("mcp-servers/sign-in/start", params),
    finishSignIn: (params: WorkbenchDaemonParams<"mcp-servers/sign-in/finish">) => this.request("mcp-servers/sign-in/finish", params),
  };

  readonly projectStore = {
    read: (params: WorkbenchDaemonParams<"project/store/read">) => this.request("project/store/read", params),
    update: (params: WorkbenchDaemonParams<"project/store/update">) => this.request("project/store/update", params),
  };

  readonly projectDiscoverySettings = {
    read: () => this.request("project/discovery-settings/read", {}),
    update: (params: WorkbenchDaemonParams<"project/discovery-settings/update">) => this.request("project/discovery-settings/update", params),
  };

  readonly projectCreation = {
    listFolders: (params: WorkbenchDaemonParams<"project/folders/list">) => this.request("project/folders/list", params),
    create: (params: WorkbenchDaemonParams<"project/create">) => this.request("project/create", params),
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
    startImport: () => this.request("stats/import/start", {}),
    refreshRateLimits: () => this.request("stats/rate-limits/refresh", {}),
    deleteFeedback: (ids: number[]) => this.request("stats/feedback/delete", { ids }),
    resolveFeedback: (ids: number[], resolved: boolean) => this.request("stats/feedback/resolve", { ids, resolved }),
  };

  readonly git = {
    workingTree: {
      read: (params: WorkbenchDaemonParams<"git/working-tree/read">) => this.request("git/working-tree/read", params),
      diff: (params: WorkbenchDaemonParams<"git/working-tree/diff">) => this.request("git/working-tree/diff", params),
      preview: (params: WorkbenchDaemonParams<"git/working-tree/preview">) => this.request("git/working-tree/preview", params),
      mutate: (params: WorkbenchDaemonParams<"git/working-tree/mutate">) => this.request("git/working-tree/mutate", params),
    },
    object: {
      read: (params: WorkbenchDaemonParams<"git/object/read">) => this.request("git/object/read", params),
      diff: (params: WorkbenchDaemonParams<"git/object/diff">) => this.request("git/object/diff", params),
      preview: (params: WorkbenchDaemonParams<"git/object/preview">) => this.request("git/object/preview", params),
    },
    mutateRef: (params: WorkbenchDaemonParams<"git/ref/mutate">) => this.request("git/ref/mutate", params),
    arc: {
      compare: (params: WorkbenchDaemonParams<"git/arc/compare">, options?: WorkbenchDaemonRequestOptions) =>
        this.requestGitArc("git/arc/compare", params, options),
      release: (params: WorkbenchDaemonParams<"git/arc/release">) => this.requestGitArc("git/arc/release", params),
      remove: (params: WorkbenchDaemonParams<"git/arc/remove">) => this.requestGitArc("git/arc/remove", params),
      restore: (params: WorkbenchDaemonParams<"git/arc/restore">) => this.requestGitArc("git/arc/restore", params),
      stash: (params: WorkbenchDaemonParams<"git/arc/stash">) => this.requestGitArc("git/arc/stash", params),
      unstash: (params: WorkbenchDaemonParams<"git/arc/unstash">) => this.requestGitArc("git/arc/unstash", params),
      discardStash: (params: WorkbenchDaemonParams<"git/arc/stash/discard">) => this.requestGitArc("git/arc/stash/discard", params),
      diffArtifact: (params: WorkbenchDaemonParams<"git/arc/diff-artifact/read">) => this.requestGitArc("git/arc/diff-artifact/read", params),
      proposal: {
        read: (params: WorkbenchDaemonParams<"git/arc/proposal/read">) => this.requestGitArc("git/arc/proposal/read", params),
        commit: (params: WorkbenchDaemonParams<"git/arc/proposal/commit">) => this.requestGitArc("git/arc/proposal/commit", params),
        commitMany: (params: WorkbenchDaemonParams<"git/arc/proposals/commit">) => this.requestGitArc("git/arc/proposals/commit", params),
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

  /** Any daemon method, validated against its registered response schema; the grouped methods above are shorthands. */
  async request<TMethod extends WorkbenchDaemonMethod>(
    method: TMethod,
    params: WorkbenchDaemonParams<TMethod>,
    options?: WorkbenchDaemonRequestOptions,
  ): Promise<WorkbenchDaemonResult<TMethod>> {
    const result = await this.transport.request<WorkbenchDaemonResult<TMethod>>(method, params, options);
    const parsed = getWorkbenchDaemonResultSchema(method).safeParse(result);
    if (!parsed.success) {
      reportClientSchemaError(`Rejected ${method} response`, parsed.error);
      throw new Error(`The ${method} response was invalid.`);
    }
    return isWorkbenchDaemonResultParsed(method) ? parsed.data as WorkbenchDaemonResult<TMethod> : result;
  }

  private async requestGitArc<TMethod extends WorkbenchDaemonGitArcMethod>(
    method: TMethod,
    params: WorkbenchDaemonParams<TMethod>,
    options?: WorkbenchDaemonRequestOptions,
  ): Promise<WorkbenchDaemonResult<TMethod>> {
    try {
      return await this.request(method, params, options);
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
