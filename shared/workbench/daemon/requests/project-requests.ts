/*
 * Exports:
 * - projectDaemonRequests: daemon requests for the project catalogue, trees, files, stores, discovery, creation, search, native file
 *   actions, and the agent and skill catalogues.
 * - WorkbenchFileWriteResult: successful save or optimistic-write conflict.
 * - WorkbenchAgentDefinitionResponse/WorkbenchSkillCatalogResponse/WorkbenchInstructionPack: agent and skill catalogue results.
 */
import { z } from "zod";
import type {
  CreateEntryPayload,
  DeleteFileResponse,
  FilePayload,
  OpenFileInEditorRequest,
  OpenFileInEditorResponse,
  ResolveExternalFileLinkRootsRequest,
  ResolveExternalFileLinkRootsResponse,
  RevealProjectEntryRequest,
  RevealProjectEntryResponse,
  SaveConflictPayload,
  SaveFilePayload,
  WorkbenchAgentDefinition,
  WorkbenchAgentOption,
  WorkbenchProjectsPayload,
  WorkbenchSkillSummary,
} from "../../../types.ts";
import { FilePayloadSchema } from "../../project/project-file.ts";
import {
  ProjectCreateResultSchema, ProjectFolderListSchema,
  type ProjectCreateRequest, type ProjectCreateResult, type ProjectFolderList, type ProjectFolderListRequest,
} from "../../project/project-creation.ts";
import {
  ProjectDiscoverySettingsReadSchema, ProjectDiscoverySettingsResultSchema,
  type ProjectDiscoverySettingsResult, type ProjectDiscoverySettingsUpdate,
} from "../../project/project-discovery-settings.ts";
import {
  WorkbenchProjectFileIndexResponseSchema,
  type WorkbenchProjectFileIndexRequest, type WorkbenchProjectFileIndexResponse,
} from "../../project/project-file-index.ts";
import { WorkbenchProjectLocationsPayloadSchema, type WorkbenchProjectLocationsPayload } from "../../project/project-location.ts";
import {
  WorkbenchCreateEntryResultSchema, WorkbenchDeleteFileResultSchema, WorkbenchProjectsPayloadSchema,
} from "../../project/project-state.ts";
import {
  ProjectStoreSnapshotSchema, ProjectStoreUpdateResultSchema,
  type ProjectStoreReadRequest, type ProjectStoreSnapshot, type ProjectStoreUpdateRequest, type ProjectStoreUpdateResult,
} from "../../project/project-store.ts";
import { WorkbenchSearchResponseSchema, type WorkbenchSearchRequest, type WorkbenchSearchResponse } from "../../search/workbench-search.ts";
import { defineDaemonRequest } from "../define-daemon-request.ts";

export interface WorkbenchInstructionPack {
  content: string;
  name: string;
  path: string;
}

export interface WorkbenchAgentDefinitionResponse {
  providerGlobalDuplicate: boolean;
  data: WorkbenchAgentDefinition;
}

export interface WorkbenchSkillCatalogResponse {
  data: WorkbenchSkillSummary[];
  instructionPacks: WorkbenchInstructionPack[];
  instructions: string;
}

export type WorkbenchFileWriteResult = SaveFilePayload | SaveConflictPayload;

const recordSchema = z.object({}).passthrough();
const fileWriteSchema = z.union([
  z.object({ actualMtimeMs: z.number(), error: z.string(), expectedMtimeMs: z.number(), path: z.string() }).passthrough(),
  z.object({ changes: z.record(z.string(), recordSchema), mtimeMs: z.number(), path: z.string(), projectId: z.string(), updatedAt: z.string() }).passthrough(),
]);

export const projectDaemonRequests = {
  "project/catalog/read": defineDaemonRequest<object, WorkbenchProjectsPayload>()({ route: "installation", result: WorkbenchProjectsPayloadSchema }),
  "project/locations/read": defineDaemonRequest<object, WorkbenchProjectLocationsPayload>()({
    // App-owned projection read.
    route: "app", result: WorkbenchProjectLocationsPayloadSchema,
  }),
  "project/tree/refresh": defineDaemonRequest<{ projectId: string }, { accepted: true }>()({
    route: "folder", result: z.object({ accepted: z.literal(true) }),
  }),
  "project/entry/create": defineDaemonRequest<
    { projectId: string; parentPath: string; name: string; type: "directory" | "file" }, CreateEntryPayload
  >()({ route: "folder", result: WorkbenchCreateEntryResultSchema }),
  "project/file/delete": defineDaemonRequest<{ projectId: string; path: string; confirmUntracked?: boolean }, DeleteFileResponse>()({
    route: "folder", result: WorkbenchDeleteFileResultSchema,
  }),
  "project/file-index/read": defineDaemonRequest<WorkbenchProjectFileIndexRequest, WorkbenchProjectFileIndexResponse>()({
    route: "folder", result: WorkbenchProjectFileIndexResponseSchema,
  }),
  "project/file/read": defineDaemonRequest<{ path: string; projectId: string }, FilePayload>()({ route: "folder", result: FilePayloadSchema }),
  "project/file/reset": defineDaemonRequest<
    { expectedMtimeMs: number; force?: boolean; path: string; projectId: string }, WorkbenchFileWriteResult
  >()({ route: "folder", result: fileWriteSchema }),
  "project/file/save": defineDaemonRequest<
    { content: string; expectedMtimeMs: number; force?: boolean; path: string; projectId: string }, WorkbenchFileWriteResult
  >()({ route: "folder", result: fileWriteSchema }),
  "project/store/read": defineDaemonRequest<ProjectStoreReadRequest, ProjectStoreSnapshot>()({ route: "folder", result: ProjectStoreSnapshotSchema }),
  "project/store/update": defineDaemonRequest<ProjectStoreUpdateRequest, ProjectStoreUpdateResult>()({
    route: "folder", result: ProjectStoreUpdateResultSchema,
  }),
  "project/discovery-settings/read": defineDaemonRequest<object, ProjectDiscoverySettingsUpdate>()({
    route: "installation", result: ProjectDiscoverySettingsReadSchema,
  }),
  "project/discovery-settings/update": defineDaemonRequest<ProjectDiscoverySettingsUpdate, ProjectDiscoverySettingsResult>()({
    route: "installation", result: ProjectDiscoverySettingsResultSchema,
  }),
  "project/folders/list": defineDaemonRequest<ProjectFolderListRequest, ProjectFolderList>()({ route: "installation", result: ProjectFolderListSchema }),
  "project/create": defineDaemonRequest<ProjectCreateRequest, ProjectCreateResult>()({ route: "installation", result: ProjectCreateResultSchema }),
  "search/query": defineDaemonRequest<WorkbenchSearchRequest, WorkbenchSearchResponse>()({ route: "folder", result: WorkbenchSearchResponseSchema }),
  "native/file/open": defineDaemonRequest<OpenFileInEditorRequest, OpenFileInEditorResponse>()({
    route: "folder", result: z.object({ ok: z.literal(true), path: z.string(), projectId: z.string().nullable() }).passthrough(),
  }),
  "native/file/reveal": defineDaemonRequest<RevealProjectEntryRequest, RevealProjectEntryResponse>()({
    route: "folder", result: z.object({ ok: z.literal(true), path: z.string(), projectId: z.string().nullable() }).passthrough(),
  }),
  "native/file/link-roots": defineDaemonRequest<ResolveExternalFileLinkRootsRequest, ResolveExternalFileLinkRootsResponse>()({
    route: "folder", result: z.object({ roots: z.array(recordSchema) }).strict(),
  }),
  "agents/list": defineDaemonRequest<{ projectId: string }, { data: WorkbenchAgentOption[] }>()({
    route: "folder", result: z.object({ data: z.array(recordSchema) }).strict(),
  }),
  "agents/read": defineDaemonRequest<{ agentPath: string; projectId: string; provider: string }, WorkbenchAgentDefinitionResponse>()({
    route: "folder", result: z.object({ providerGlobalDuplicate: z.boolean(), data: recordSchema }).strict(),
  }),
  "skills/read": defineDaemonRequest<{ projectId: string | null; provider: string }, WorkbenchSkillCatalogResponse>()({
    route: "folder", result: z.object({ data: z.array(recordSchema), instructionPacks: z.array(recordSchema), instructions: z.string() }).strict(),
  }),
};
