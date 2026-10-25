/*
 * Exports:
 * - readOpenCodeGoQuota: resolve and normalise Go quota without exposing its credential.
 * - OpenCodeGoCredential: the token, org header and private account identity a Go quota read uses.
 * - resolveOpenCodeGoCredential: select the credential of the integration OpenCode binds Go models to (Go key or Console login).
 * - OpenCodeWorkbenchPluginOptions: injectable companion boundaries for focused tests.
 * - createOpenCodeWorkbenchPlugin: create the process-local OpenCode companion.
 * - MANAGED_NATIVE_TOOLS: the only native tools managed Workbench sessions keep; all others are hidden and denied.
 * - default plugin: preserve ordinary OpenCode sessions while adapting managed Workbench sessions.
 */
import { z } from "zod";
import type { Plugin } from "@opencode/plugin/promise/plugin";
import type { ConnectionInfo } from "@opencode/client";
import OpenCodeCompanionToolsController, { type CompanionToolClient } from "./OpenCodeCompanionToolsController";
import OpenCodePatchStreamController from "./OpenCodePatchStreamController";
import OpenCodeFileEvidenceController from "./OpenCodeFileEvidenceController";
import OpenCodeStreamCutController from "./OpenCodeStreamCutController";
import { OPENCODE_COMMENTARY_HINT, registerOpenCodeCommentaryTool } from "./open-code-commentary-tool";
import { registerOpenCodeEndTurnTool } from "./open-code-end-turn-tool";
import providerAccountFingerprint from "../../provider-account-fingerprint";
import {
  isOpenCodeWorkbenchToolName,
  OPENCODE_COMMENTARY_TOOL_NAME,
  OPENCODE_TASK_STATUS_TOOLS,
  openCodeWorkbenchRpc,
  OpenCodeGoQuotaSchema,
  type OpenCodeGoQuotaResult,
} from "../opencode-workbench-rpc";

const WORKBENCH_PLUGIN_ID = "workbench";
const MANAGED_CODE_MODE_SCOPE =
  "Call the nested Workbench tools listed here only. Native OpenCode tools such as edit, write, and patch and direct `wbex_*` tools remain direct OpenCode tools outside this catalogue.";
/**
 * Managed sessions expose only these native tools, so new OpenCode tools stay hidden until listed. wb replaces shell,
 * search, skills, questions and subagents; native read hangs on missing paths and directories, so agents read through
 * the wb shell. `execute` hosts the nested code-mode wb tools.
 */
export const MANAGED_NATIVE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch", "execute", "webfetch", "websearch"]);
const OPENCODE_HOSTED_PROVIDERS = new Set(["opencode", "opencode-go"]);

function isManagedTool(tool: string) {
  return MANAGED_NATIVE_TOOLS.has(tool) || isOpenCodeWorkbenchToolName(tool) || tool === OPENCODE_COMMENTARY_TOOL_NAME;
}

export interface OpenCodeWorkbenchPluginOptions {
  connectTools?: (url: string) => Promise<CompanionToolClient>;
  isManagedSession?: (sessionID: string) => Promise<boolean>;
  resolveDaemonOrigin?: () => Promise<string>;
  fetch?: typeof fetch;
}

const goQuotaResponseSchema = z.object({
  usage: z.object({
    rolling: z.object({ status: z.string(), percent: z.number(), resetsAt: z.iso.datetime() }),
    weekly: z.object({ status: z.string(), percent: z.number(), resetsAt: z.iso.datetime() }),
    monthly: z.object({ status: z.string(), percent: z.number(), resetsAt: z.iso.datetime() }),
  }),
});

const goErrorSchema = z.object({ error: z.object({ code: z.string() }) });

/** What a Go quota read sends, plus a private account identity that survives token refreshes. */
export interface OpenCodeGoCredential {
  token: string;
  orgID: string | null;
  identity: string;
  label: string | null;
}

type ResolvedCredential = { type: string; key?: string; access?: string; metadata?: Record<string, unknown> };

/**
 * Go models authenticate through whichever integration OpenCode binds the `opencode-go` provider to: its own key, or the
 * OpenCode Console login once one is connected. Quota reads use the same credential and org header.
 */
export async function resolveOpenCodeGoCredential(context: {
  provider: { get(input: { providerID: string }): Promise<{ data: { integrationID?: string } }> };
  integration: {
    connection: {
      active(integrationID: string): Promise<ConnectionInfo | undefined>;
      resolve(connection: ConnectionInfo): Promise<ResolvedCredential | undefined>;
    };
    get(input: { integrationID: string }): Promise<{ data: { connections: ConnectionInfo[] } }>;
  };
}): Promise<OpenCodeGoCredential | undefined> {
  const integrationID = (await context.provider.get({ providerID: "opencode-go" })).data.integrationID ?? "opencode-go";
  const { integration } = context;
  let connection = await integration.connection.active(integrationID);
  if (!connection) {
    const credentials = (await integration.get({ integrationID })).data.connections
      .filter(candidate => candidate.type === "credential");
    connection = credentials.length === 1 ? credentials[0] : undefined;
  }
  const credential = connection ? await integration.connection.resolve(connection) : undefined;
  const token = credential?.type === "key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined;
  if (!credential || !token) return undefined;
  const text = (key: string) => {
    const value = credential.metadata?.[key];
    return typeof value === "string" ? value : null;
  };
  const orgID = text("orgID");
  const accountID = credential.type === "oauth" ? text("accountID") : null;
  return {
    token, orgID,
    identity: accountID ? `${accountID}\0${orgID ?? ""}` : token,
    label: credential.type === "oauth" ? text("email") : null,
  };
}

export async function readOpenCodeGoQuota(options: {
  fetch?: typeof fetch;
  now?: () => number;
  resolveCredential(): Promise<OpenCodeGoCredential | undefined>;
  signal?: AbortSignal;
}): Promise<OpenCodeGoQuotaResult> {
  const observedAt = (options.now ?? Date.now)();
  let credential: OpenCodeGoCredential | undefined;
  try {
    credential = await options.resolveCredential();
  } catch {
    return {
      ok: false,
      error: { kind: "credential", message: "OpenCode Go credential resolution failed." },
    };
  }
  if (!credential) {
    return {
      ok: false,
      error: { kind: "credential", message: "OpenCode Go has no available credential." },
    };
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)("https://opencode.ai/zen/go/v1/usage", {
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...credential.orgID ? { "x-org-id": credential.orgID } : {},
      },
      signal: options.signal,
    });
  } catch {
    return {
      ok: false,
      error: { kind: "request", message: "OpenCode Go usage request failed." },
    };
  }
  if (response.status === 401) {
    const expired = goErrorSchema.safeParse(await response.json().catch(() => null)).data?.error.code === "api_key_expired";
    return {
      ok: false,
      error: {
        kind: "response",
        message: expired
          ? "OpenCode Go's API key has expired; sign in to OpenCode Console or replace the key."
          : "OpenCode Go rejected its active credential.",
      },
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      error: { kind: "response", message: "OpenCode Go quota is unavailable for the active account." },
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: { kind: "response", message: `OpenCode Go usage request failed (${response.status}).` },
    };
  }
  let parsed: z.infer<typeof goQuotaResponseSchema>;
  try {
    parsed = goQuotaResponseSchema.parse(await response.json());
  } catch {
    return {
      ok: false,
      error: { kind: "response", message: "OpenCode Go returned invalid quota data." },
    };
  }
  const window = (value: typeof parsed.usage.rolling) => ({
    percent: value.percent,
    resetsAt: Date.parse(value.resetsAt),
    status: value.status,
  });
  const quota = OpenCodeGoQuotaSchema.safeParse({
    accountFingerprint: providerAccountFingerprint("opencode", credential.identity),
    accountLabel: credential.label,
    observedAt,
    windows: {
      rolling: window(parsed.usage.rolling),
      weekly: window(parsed.usage.weekly),
      monthly: window(parsed.usage.monthly),
    },
  });
  return quota.success
    ? { ok: true, quota: quota.data }
    : {
        ok: false,
        error: { kind: "response", message: "OpenCode Go returned invalid quota data." },
      };
}

function isManagedMetadata(metadata: Record<string, unknown> | undefined) {
  const workbench = metadata?.workbench;
  return Boolean(workbench && typeof workbench === "object"
    && "managed" in workbench && workbench.managed === true);
}

export function createOpenCodeWorkbenchPlugin(
  options: OpenCodeWorkbenchPluginOptions = {},
): Plugin {
  return {
    id: WORKBENCH_PLUGIN_ID,
    setup: async context => {
      const isManagedSession = options.isManagedSession ?? (async sessionID =>
        isManagedMetadata((await context.session.get({ sessionID })).metadata));
      const cuts = new OpenCodeStreamCutController({
        isManagedSession,
        hint: async sessionID => {
          await context.session.synthetic({ sessionID, text: OPENCODE_COMMENTARY_HINT, delivery: "steer" });
        },
        warn: message => console.warn(`[workbench-opencode-cut] ${message}`),
      });
      const tools = new OpenCodeCompanionToolsController({
        ...options,
        isManagedSession,
        succeeded: (sessionID, name) => { if (OPENCODE_TASK_STATUS_TOOLS.has(name)) cuts.taskStatusSet(sessionID); },
      });
      await tools.load().catch(async error => {
        try { await tools.dispose(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Workbench catalogue loading and cleanup failed."); }
        throw error;
      });
      const rpc = await context.rpc.register(openCodeWorkbenchRpc, {
        goQuota: async (_input, { signal }) => readOpenCodeGoQuota({
          signal,
          resolveCredential: () => resolveOpenCodeGoCredential(context),
        }),
      }).catch(async error => {
        const closed = await Promise.allSettled([tools.dispose()]);
        throw new AggregateError([error, ...closed.flatMap(result => result.status === "rejected" ? [result.reason] : [])],
          "Workbench companion RPC registration failed.");
      });
      const files = new OpenCodeFileEvidenceController({
        isManagedSession,
        resolveCwd: async sessionID => (await context.session.get({ sessionID })).location.directory,
        warn: message => console.warn(`[workbench-opencode-files] ${message}`),
      });
      const patches = new OpenCodePatchStreamController({
        isManagedSession,
        isNewWrite: (sessionID, file) => files.isNewWrite(sessionID, file),
        emit: observation => rpc.events.emit("patchPreview", observation),
        warn: message => console.warn(`[workbench-opencode-preview] ${message}`),
      });
      const sessionLifetime = new AbortController();
      const sessionEvents = (async () => {
        try {
          for await (const event of context.event.subscribe({ signal: sessionLifetime.signal })) {
            if (event.type === "session.inbox.enqueued") {
              if (event.data.item.type === "user" && event.data.item.delivery === "steer") {
                await cuts.steerPending(event.data.sessionID, event.data.inboxID);
              }
            } else if (event.type === "session.inbox.delivery.changed") {
              if (event.data.delivery === "steer") await cuts.steerPending(event.data.sessionID, event.data.inboxID);
              else cuts.steerResolved(event.data.sessionID, event.data.inboxID);
            } else if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") {
              cuts.steerResolved(event.data.sessionID, event.data.inboxID);
            } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed"
              || event.type === "session.execution.interrupted") {
              cuts.settleSession(event.data.sessionID);
              await Promise.all([patches.settleSession(event.data.sessionID), files.settleSession(event.data.sessionID)]);
            }
          }
          if (!sessionLifetime.signal.aborted) {
            console.warn("[workbench-opencode] Session event subscription ended; previews and stream cuts disabled.");
            cuts.dispose();
            await Promise.all([patches.dispose(), files.dispose()]);
          }
        } catch {
          if (!sessionLifetime.signal.aborted) {
            console.warn("[workbench-opencode] Session event subscription failed; previews and stream cuts disabled.");
            cuts.dispose();
            await Promise.all([patches.dispose(), files.dispose()]);
          }
        }
      })();
      const registrations = await Promise.allSettled([
        rpc,
        // Patch observation wraps the provider body first; the stream cutter wraps that, so a cut cancels both.
        context.session.hook("http.response", async input => {
          await patches.httpResponse(input);
          await cuts.httpResponse(input);
        }),
        context.session.hook("experimental.ws.send", input => patches.websocketSend(input)),
        context.session.hook("experimental.ws.receive", input => patches.websocketReceive(input)),
        context.tool.transform(editor => {
          tools.register(editor);
          registerOpenCodeCommentaryTool(editor, sessionID => cuts.hasTaskStatus(sessionID));
          registerOpenCodeEndTurnTool(editor, sessionID => cuts.endTurn(sessionID));
        }),
        context.permission.hook("evaluate", async input => {
          if (input.action !== "edit") return;
          try {
            if (!await isManagedSession(input.sessionID)) return;
            const session = await context.session.get({ sessionID: input.sessionID });
            const decision = await tools.checkFiles(input.sessionID, input.resources, session.location.directory);
            if (decision.allowed === false) {
              input.effect = "deny";
              input.message = decision.reason;
            }
          } catch {
            console.warn("[workbench-opencode] Native file claim admission failed; mutation denied.");
            input.effect = "deny";
            input.message = "Workbench could not verify file claims. No files were changed. Restore the Workbench connection before retrying.";
          }
        }),
        context.session.hook("context", async input => {
          const managed = await isManagedSession(input.sessionID);
          const execute = input.tools.execute;
          if (managed && execute && !execute.description.includes(MANAGED_CODE_MODE_SCOPE)) {
            execute.description = `${execute.description}\n\n${MANAGED_CODE_MODE_SCOPE}`;
          }
          for (const tool of Object.keys(input.tools)) {
            if (managed ? !isManagedTool(tool)
              : isOpenCodeWorkbenchToolName(tool) || tool === OPENCODE_COMMENTARY_TOOL_NAME) {
              delete input.tools[tool];
            }
          }
        }),
        context.session.hook("http.request", input => {
          if (OPENCODE_HOSTED_PROVIDERS.has(input.model.providerID)) {
            const headers = new Headers(input.request.headers);
            headers.set("x-opencode-session", input.sessionID);
            headers.set("user-agent", `opencode/${context.app.version}`);
            input.request = new Request(input.request, { headers });
          }
        }),
        context.tool.hook("execute.before", async input => {
          cuts.toolCalled(input.sessionID, input.tool);
          if (!isManagedTool(input.tool) && await isManagedSession(input.sessionID)) {
            throw new Error(`Native OpenCode tool ${input.tool} is unavailable in a managed Workbench session.`);
          }
          await files.before(input);
        }),
        context.tool.hook("execute.after", input => files.after(input)),
      ]);
      const dispose = async () => {
        sessionLifetime.abort();
        cuts.dispose();
        await Promise.all([sessionEvents, patches.dispose(), files.dispose()]);
        const closed = await Promise.allSettled([
          ...registrations.flatMap(result => result.status === "fulfilled" ? [result.value.dispose()] : []),
        ]);
        closed.push(...await Promise.allSettled([tools.dispose()]));
        const failures = closed.filter(result => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Workbench companion cleanup failed.");
      };
      const failures = registrations.filter(result => result.status === "rejected");
      if (failures.length) {
        await dispose();
        throw new AggregateError(failures.map(result => result.reason), "Workbench companion registration failed.");
      }
      return dispose;
    },
  };
}

export default createOpenCodeWorkbenchPlugin();
