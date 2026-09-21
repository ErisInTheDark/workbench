/*
 * Exports:
 * - readOpenCodeGoQuota: resolve and normalise Go quota without exposing its credential.
 * - resolveOpenCodeGoCredential: select the active or sole unambiguous Go credential inside OpenCode.
 * - OpenCodeWorkbenchPluginOptions: injectable companion boundaries for focused tests.
 * - createOpenCodeWorkbenchPlugin: create the process-local OpenCode companion.
 * - default plugin: preserve ordinary OpenCode sessions while adapting managed Workbench sessions.
 */
import { z } from "zod";
import type { Plugin } from "@opencode/plugin/promise/plugin";
import type { ConnectionInfo } from "@opencode/client";
import OpenCodeCompanionToolsController, { type CompanionToolClient } from "./OpenCodeCompanionToolsController";
import OpenCodePatchStreamController from "./OpenCodePatchStreamController";
import OpenCodeFileEvidenceController from "./OpenCodeFileEvidenceController";
import {
  openCodeWorkbenchRpc,
  OpenCodeGoQuotaSchema,
  type OpenCodeGoQuotaResult,
} from "../opencode-workbench-rpc";

const WORKBENCH_PLUGIN_ID = "workbench";
const WORKBENCH_MCP_NAME = "wb";
const MANAGED_CODE_MODE_SCOPE =
  "Search and call nested Workbench tools only. Native OpenCode tools such as edit, write, and apply_patch remain direct OpenCode tools outside this catalogue.";
const MANAGED_DISABLED_NATIVE_TOOLS = new Set(["bash", "question", "shell"]);
const OPENCODE_HOSTED_PROVIDERS = new Set(["opencode", "opencode-go"]);

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

export async function resolveOpenCodeGoCredential(integration: {
  connection: {
    active(integrationID: string): Promise<ConnectionInfo | undefined>;
    resolve(connection: ConnectionInfo): Promise<{ type: string; key?: string; access?: string } | undefined>;
  };
  get(input: { integrationID: string }): Promise<{ data: { connections: ConnectionInfo[] } }>;
}) {
  const active = await integration.connection.active("opencode-go");
  if (active) {
    const credential = await integration.connection.resolve(active);
    return credential?.type === "key" ? credential : undefined;
  }
  const current = await integration.get({ integrationID: "opencode-go" });
  const credentials = current.data.connections.filter(connection => connection.type === "credential");
  const credential = credentials.length === 1 ? await integration.connection.resolve(credentials[0]!) : undefined;
  return credential?.type === "key" ? credential : undefined;
}

export async function readOpenCodeGoQuota(options: {
  fetch?: typeof fetch;
  now?: () => number;
  resolveCredential(): Promise<{ type: string; key?: string; access?: string } | undefined>;
  signal?: AbortSignal;
}): Promise<OpenCodeGoQuotaResult> {
  const observedAt = (options.now ?? Date.now)();
  let credential: Awaited<ReturnType<typeof options.resolveCredential>>;
  try {
    credential = await options.resolveCredential();
  } catch {
    return {
      ok: false,
      error: { kind: "credential", message: "OpenCode Go credential resolution failed." },
    };
  }
  const token = credential?.type === "key" ? credential.key : undefined;
  if (!token) {
    return {
      ok: false,
      error: { kind: "credential", message: "OpenCode Go has no available credential." },
    };
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)("https://opencode.ai/zen/go/v1/usage", {
      headers: { authorization: `Bearer ${token}` },
      signal: options.signal,
    });
  } catch {
    return {
      ok: false,
      error: { kind: "request", message: "OpenCode Go usage request failed." },
    };
  }
  if (response.status === 401) {
    return {
      ok: false,
      error: { kind: "response", message: "OpenCode Go rejected its active credential." },
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

function isWorkbenchTool(tool: string) {
  return tool === WORKBENCH_MCP_NAME || tool.startsWith(`${WORKBENCH_MCP_NAME}_`);
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
      const tools = new OpenCodeCompanionToolsController({ ...options, isManagedSession });
      await tools.load().catch(async error => {
        try { await tools.dispose(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Workbench catalogue loading and cleanup failed."); }
        throw error;
      });
      const rpc = await context.rpc.register(openCodeWorkbenchRpc, {
        goQuota: async (_input, { signal }) => readOpenCodeGoQuota({
          signal,
          resolveCredential: () => resolveOpenCodeGoCredential(context.integration),
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
      const previewLifetime = new AbortController();
      const previewEvents = (async () => {
        try {
          for await (const event of context.event.subscribe({ signal: previewLifetime.signal })) {
            if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed"
              || event.type === "session.execution.interrupted") {
              await Promise.all([patches.settleSession(event.data.sessionID), files.settleSession(event.data.sessionID)]);
            }
          }
          if (!previewLifetime.signal.aborted) {
            console.warn("[workbench-opencode-preview] Preview lifecycle subscription ended; previews disabled.");
            await Promise.all([patches.dispose(), files.dispose()]);
          }
        } catch {
          if (!previewLifetime.signal.aborted) {
            console.warn("[workbench-opencode-preview] Preview lifecycle subscription failed; previews disabled.");
            await Promise.all([patches.dispose(), files.dispose()]);
          }
        }
      })();
      const registrations = await Promise.allSettled([
        rpc,
        context.session.hook("http.response", input => patches.httpResponse(input)),
        context.session.hook("experimental.ws.send", input => patches.websocketSend(input)),
        context.session.hook("experimental.ws.receive", input => patches.websocketReceive(input)),
        context.tool.transform(editor => tools.register(editor)),
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
            if (managed ? MANAGED_DISABLED_NATIVE_TOOLS.has(tool) : isWorkbenchTool(tool)) {
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
          const managed = await isManagedSession(input.sessionID);
          if (MANAGED_DISABLED_NATIVE_TOOLS.has(input.tool) && managed) {
            throw new Error(`Native OpenCode tool ${input.tool} is unavailable in a managed Workbench session.`);
          }
          await files.before(input);
        }),
        context.tool.hook("execute.after", input => files.after(input)),
      ]);
      const dispose = async () => {
        previewLifetime.abort();
        await Promise.all([previewEvents, patches.dispose(), files.dispose()]);
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
