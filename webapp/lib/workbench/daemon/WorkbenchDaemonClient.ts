/*
 * Exports:
 * - WorkbenchDaemonTransport: existing socket request port used by the daemon client. Keywords: daemon, websocket, transport.
 * - WorkbenchDaemonRequestError: typed JSON-RPC failure with bounded domain data. Keywords: daemon, rpc, error.
 * - WorkbenchDaemonClient: typed semantic daemon request client. Keywords: daemon, rpc.
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
    const result = await this.transport.request<WorkbenchDaemonResult<TMethod>>(method, params);
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
