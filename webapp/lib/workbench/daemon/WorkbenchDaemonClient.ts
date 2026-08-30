/*
 * Exports:
 * - WorkbenchDaemonTransport: existing socket request port used by the daemon client. Keywords: daemon, websocket, transport.
 * - WorkbenchDaemonRequestError: typed JSON-RPC failure used to gate old-daemon fallback. Keywords: daemon, rpc, error, fallback.
 * - WorkbenchDaemonClient: typed semantic daemon request client with narrow old-daemon compatibility. Keywords: daemon, rpc, fallback.
 * - default WorkbenchDaemonClient: create the browser daemon client. Keywords: daemon, client.
 */
import type {
  WorkbenchDaemonGitArcMethod,
  WorkbenchDaemonMethod,
  WorkbenchDaemonParams,
  WorkbenchDaemonResult,
} from "./workbench-daemon-requests";
import { WORKBENCH_GIT_ARC_ACTION_BY_METHOD } from "./workbench-daemon-requests";
import { z } from "zod";
import {
  GitCheckpointCompareResultSchema,
  GitCheckpointProposalSchema,
} from "../git/checkpoint-contracts";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  GitArcFailureSchema,
} from "../git/git-arc-failures";
import reportClientSchemaError from "../report-client-schema-error";
import { WorkbenchProjectsPayloadSchema } from "../project/project-state";

export interface WorkbenchDaemonTransport {
  request<TResponse>(method: string, params: object): Promise<TResponse>;
}

export class WorkbenchDaemonRequestError extends Error {
  constructor(message: string, readonly code: number, readonly data: object | null = null) {
    super(message);
    this.name = "WorkbenchDaemonRequestError";
  }
}

async function readJson(response: Response) {
  const payload = await response.json() as object & { error?: string };
  if (!response.ok) throw new Error(payload.error || "The legacy Workbench request failed.");
  return payload;
}

async function legacyGitArcRequest(method: WorkbenchDaemonGitArcMethod, params: object) {
  const response = await fetch("/api/git-checkpoint", {
    body: JSON.stringify({ action: WORKBENCH_GIT_ARC_ACTION_BY_METHOD[method], ...params }),
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    try {
      const payload = JSON.parse(text) as { error?: string; gitArcFailure?: object };
      throw new WorkbenchDaemonRequestError(
        payload.error || "The legacy Git arc request failed.",
        -32000,
        payload.gitArcFailure ? { gitArcFailure: payload.gitArcFailure } : null,
      );
    } catch (error) {
      if (error instanceof WorkbenchDaemonRequestError) throw error;
      throw new WorkbenchDaemonRequestError(text.trim() || "The legacy Git arc request failed.", -32000);
    }
  }
  if (method === "git/arc/diff-artifact/read") return text;
  if (method === "git/arc/remove" || method === "git/arc/restore") return { ok: true };
  return JSON.parse(text) as object;
}

async function legacyRequest(method: WorkbenchDaemonMethod, params: object) {
  if (method in WORKBENCH_GIT_ARC_ACTION_BY_METHOD) {
    return await legacyGitArcRequest(method as WorkbenchDaemonGitArcMethod, params);
  }
  const json = async (path: string, init?: RequestInit) => readJson(await fetch(path, { cache: "no-store", ...init }));
  switch (method) {
    case "project/catalog/read": return await json("/api/projects");
    case "project/file/read": {
      const value = params as WorkbenchDaemonParams<typeof method>;
      return await json(`/api/file?projectId=${encodeURIComponent(value.projectId)}&path=${encodeURIComponent(value.path)}`);
    }
    case "project/file/save":
    case "project/file/reset": {
      const value = params as WorkbenchDaemonParams<typeof method>;
      return await json("/api/file", {
        body: JSON.stringify({ ...value, resetToHead: method.endsWith("/reset") }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
    }
    case "local-capabilities/read": return await json("/api/workbench-settings");
    case "local-capabilities/update": return await json("/api/workbench-settings", {
      body: JSON.stringify(params), headers: { "Content-Type": "application/json" }, method: "PUT",
    });
    case "agents/list": {
      const value = params as WorkbenchDaemonParams<typeof method>;
      return await json(`/api/agents?projectId=${encodeURIComponent(value.projectId)}`);
    }
    case "agents/read": {
      const value = params as WorkbenchDaemonParams<typeof method>;
      return await json(`/api/agents?projectId=${encodeURIComponent(value.projectId)}&agentPath=${encodeURIComponent(value.agentPath)}`);
    }
    case "skills/read": {
      const value = params as WorkbenchDaemonParams<typeof method>;
      return await json(value.projectId
        ? `/api/workbench-library/skills?projectId=${encodeURIComponent(value.projectId)}`
        : "/api/workbench-library/skills");
    }
    case "native/file/open": return await json("/api/file/open", {
      body: JSON.stringify(params), headers: { "Content-Type": "application/json" }, method: "POST",
    });
    case "native/file/reveal": return await json("/api/file/reveal", {
      body: JSON.stringify(params), headers: { "Content-Type": "application/json" }, method: "POST",
    });
    case "native/file/link-roots": return await json("/api/file/link-roots", {
      body: JSON.stringify(params), headers: { "Content-Type": "application/json" }, method: "POST",
    });
    case "browse/sessions/read": {
      const value = params as WorkbenchDaemonParams<typeof method>;
      const query = new URLSearchParams();
      if (value.projectId) query.set("projectId", value.projectId);
      if (value.threadId) query.set("threadId", value.threadId);
      if (value.cwd) query.set("cwd", value.cwd);
      query.set("includeRuntime", String(value.includeRuntime));
      query.set("timeoutMs", String(value.timeoutMs));
      return await json(`/api/browse/sessions?${query}`);
    }
    case "browse/sessions/forget":
    case "browse/sessions/stop": return await json("/api/browse/sessions", {
      body: JSON.stringify({ action: method.endsWith("/forget") ? "forget" : "stop", ...params }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    case "profiles/read": return await json("/api/composer-profiles");
    case "profiles/delete":
    case "profiles/upsert": return await json("/api/composer-profiles", {
      body: JSON.stringify({
        action: "mutate",
        mutation: method.endsWith("/delete")
          ? { kind: "delete", profileId: (params as WorkbenchDaemonParams<"profiles/delete">).profileId }
          : { kind: "upsert", profile: (params as WorkbenchDaemonParams<"profiles/upsert">).profile },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  }
}

const recordSchema = z.object({}).passthrough();
const fileWriteSchema = z.union([
  z.object({ actualMtimeMs: z.number(), error: z.string(), expectedMtimeMs: z.number(), path: z.string() }).passthrough(),
  z.object({ changes: z.record(z.string(), recordSchema), mtimeMs: z.number(), path: z.string(), projectId: z.string(), updatedAt: z.string() }).passthrough(),
]);

function schemaFor(method: WorkbenchDaemonMethod): z.ZodType {
  switch (method) {
    case "project/catalog/read": return WorkbenchProjectsPayloadSchema;
    case "project/file/read": return z.object({
      content: z.string(), headContent: z.string().nullable(), mtimeMs: z.number(), path: z.string(), projectId: z.string(), updatedAt: z.string(),
    }).strict();
    case "project/file/reset":
    case "project/file/save": return fileWriteSchema;
    case "local-capabilities/read":
    case "local-capabilities/update": return z.object({
      localCapabilities: z.object({ browseRawCommandsEnabled: z.boolean() }).strict(),
    }).strict();
    case "agents/list": return z.object({ data: z.array(recordSchema) }).strict();
    case "agents/read": return z.object({ codexGlobalDuplicate: z.boolean(), data: recordSchema }).strict();
    case "skills/read": return z.object({
      data: z.array(recordSchema), instructionPacks: z.array(recordSchema), instructions: z.string(),
    }).strict();
    case "native/file/open":
    case "native/file/reveal": return z.object({ ok: z.literal(true), path: z.string(), projectId: z.string().nullable() }).passthrough();
    case "native/file/link-roots": return z.object({ roots: z.array(recordSchema) }).strict();
    case "browse/sessions/read": return z.object({ sessions: z.array(recordSchema) }).passthrough();
    case "browse/sessions/forget":
    case "browse/sessions/stop": return recordSchema;
    case "profiles/delete":
    case "profiles/read":
    case "profiles/upsert": return z.object({ profiles: z.array(recordSchema) }).passthrough();
    case "git/arc/compare": return GitCheckpointCompareResultSchema;
    case "git/arc/proposal/commit":
    case "git/arc/proposal/read": return GitCheckpointProposalSchema;
    case "git/arc/diff-artifact/read": return z.string();
    case "git/arc/remove":
    case "git/arc/restore": return z.object({ ok: z.literal(true) }).strict();
  }
}

export class WorkbenchDaemonClient {
  constructor(private readonly transport: WorkbenchDaemonTransport) {}

  async request<TMethod extends WorkbenchDaemonMethod>(
    method: TMethod,
    params: WorkbenchDaemonParams<TMethod>,
  ): Promise<WorkbenchDaemonResult<TMethod>> {
    let result: WorkbenchDaemonResult<TMethod>;
    try {
      result = await this.transport.request<WorkbenchDaemonResult<TMethod>>(method, params);
    } catch (error) {
      if (!(error instanceof WorkbenchDaemonRequestError) || error.code !== -32601) throw error;
      result = await legacyRequest(method, params) as WorkbenchDaemonResult<TMethod>;
    }
    const parsed = schemaFor(method).safeParse(result);
    if (!parsed.success) {
      reportClientSchemaError(`Rejected ${method} response`, parsed.error);
      throw new Error(`The ${method} response was invalid.`);
    }
    return result;
  }

  async requestGitArc<TMethod extends WorkbenchDaemonGitArcMethod>(
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
