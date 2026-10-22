/*
 * Exports:
 * - projectRequestHandlers: daemon handlers for project trees, files, stores, discovery, creation, file indexes, working trees, pushes, search,
 *   native file actions, and the agent and skill catalogues.
 */
import type { OpenFileInEditorRequest, ResolveExternalFileLinkRootsRequest, RevealProjectEntryRequest } from "workbench-shared/types";
import { WorkingTreeFileRequestSchema, WorkingTreeMutationSchema, WorkingTreeReadRequestSchema } from "workbench-shared/workbench/git/working-tree-contracts";
import { GitPushRequestSchema } from "workbench-shared/workbench/git/git-history-contracts";
import { ProjectCreateRequestSchema, ProjectFolderListRequestSchema } from "workbench-shared/workbench/project/project-creation";
import { ProjectDiscoverySettingsUpdateSchema } from "workbench-shared/workbench/project/project-discovery-settings";
import { WorkbenchProjectFileIndexRequestSchema } from "workbench-shared/workbench/project/project-file-index";
import { WorkbenchProjectStateRequestSchema } from "workbench-shared/workbench/project/project-state";
import { ProjectStoreReadRequestSchema, ProjectStoreUpdateRequestSchema } from "workbench-shared/workbench/project/project-store";
import ProjectTreeFileIndex from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import { WorkbenchSearchRequestSchema } from "workbench-shared/workbench/search/workbench-search";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  defineDaemonRequestHandlers, InvalidParamsError, optionalFiniteNumber, requiredFiniteNumber, requiredString, requiredText,
  type DaemonRequestContext,
} from "./daemon-request-handler";

const PROJECT_STATE_METHODS = {
  "project/tree/refresh": "workbench/thread-state/project/refresh",
  "project/file/delete": "workbench/thread-state/project/file/delete",
} as const;

async function projectState(method: keyof typeof PROJECT_STATE_METHODS, params: Record<string, unknown>, { owners }: DaemonRequestContext) {
  const project = await owners.projects.resolveProjectById(requiredString(params, "projectId"));
  const operation = WorkbenchProjectStateRequestSchema.parse({ ...params, projectId: project.id, method: PROJECT_STATE_METHODS[method] });
  return await owners.projectSnapshot.handleRequest(project.id, operation);
}

function workingTree({ owners }: DaemonRequestContext) {
  if (!owners.workingTree) throw new Error("Working tree is unavailable.");
  return owners.workingTree;
}

function projectCreation({ owners }: DaemonRequestContext) {
  if (!owners.projectCreation) throw new Error("Project creation is unavailable.");
  return owners.projectCreation;
}

function projectStore({ owners }: DaemonRequestContext) {
  if (!owners.projectStore) throw new Error("The project store is unavailable.");
  return owners.projectStore;
}

function openFileRequest(params: Record<string, unknown>): OpenFileInEditorRequest {
  const absolutePath = params.absolutePath === null || params.absolutePath === undefined
    ? null
    : requiredString(params, "absolutePath");
  const projectId = params.projectId === null || params.projectId === undefined
    ? null
    : requiredString(params, "projectId");
  const path = typeof params.path === "string" ? params.path : "";
  if (!absolutePath && (!projectId || !path.trim())) {
    throw new InvalidParamsError("A project file or absolute path is required.");
  }
  return {
    absolutePath,
    columnNumber: optionalFiniteNumber(params, "columnNumber"),
    lineNumber: optionalFiniteNumber(params, "lineNumber"),
    path,
    projectId,
  };
}

function linkRootsRequest(params: Record<string, unknown>): ResolveExternalFileLinkRootsRequest {
  if (!Array.isArray(params.paths) || params.paths.some((value) => typeof value !== "string")) {
    throw new InvalidParamsError("paths must be an array of strings.");
  }
  return { paths: params.paths };
}

export const projectRequestHandlers = defineDaemonRequestHandlers({
  "project/tree/refresh": (params, context) => projectState("project/tree/refresh", params, context),
  "project/file/delete": (params, context) => projectState("project/file/delete", params, context),
  "project/catalog/read": async (_params, { owners }) => await owners.projects.readCatalog(),
  "project/locations/read": async (_params, { owners }) => await owners.projects.readLocations(),
  "project/discovery-settings/read": async (_params, { owners }) => await owners.projects.readDiscoverySettings(),
  "project/discovery-settings/update": async (params, { owners }) => {
    const parsed = ProjectDiscoverySettingsUpdateSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid project discovery settings.");
    return await owners.projects.updateDiscoverySettings(parsed.data.paths);
  },
  "project/folders/list": async (params, context) => {
    const creation = projectCreation(context);
    const parsed = ProjectFolderListRequestSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid folder listing request.");
    return await creation.listFolders(parsed.data.path);
  },
  "project/create": async (params, context) => {
    const creation = projectCreation(context);
    const parsed = ProjectCreateRequestSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid project creation request.");
    return await creation.create(parsed.data);
  },
  "project/file-index/read": async (params, { owners }) => {
    const request = WorkbenchProjectFileIndexRequestSchema.safeParse(params);
    if (!request.success) throw new InvalidParamsError("A project ID is required for file-index reads.");
    const { projectId } = request.data;
    const snapshot = await owners.projectSnapshot.readProjectSnapshot(projectId);
    const index = ProjectTreeFileIndex.fromTree(snapshot.tree);
    return { projectId, key: index.key, candidates: index.candidates };
  },
  "project/store/read": async (params, context) => {
    const store = projectStore(context);
    const parsed = ProjectStoreReadRequestSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("A project ID is required for project store reads.");
    return await store.read(parsed.data.projectId);
  },
  "project/store/update": async (params, context) => {
    const store = projectStore(context);
    const parsed = ProjectStoreUpdateRequestSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError(parsed.error.issues[0]?.message ?? "Invalid project store update.");
    return await store.update(parsed.data);
  },
  "project/file/read": async (params, { owners }) => await owners.files.read({
    path: requiredString(params, "path"),
    projectId: requiredString(params, "projectId"),
  }),
  "project/file/save": async (params, { owners }) => await owners.files.write({
    content: requiredText(params, "content"),
    expectedMtimeMs: requiredFiniteNumber(params, "expectedMtimeMs"),
    force: params.force === true,
    path: requiredString(params, "path"),
    projectId: requiredString(params, "projectId"),
    resetToHead: false,
  }),
  "project/file/reset": async (params, { owners }) => await owners.files.write({
    expectedMtimeMs: requiredFiniteNumber(params, "expectedMtimeMs"),
    force: params.force === true,
    path: requiredString(params, "path"),
    projectId: requiredString(params, "projectId"),
    resetToHead: true,
  }),
  "git/working-tree/read": async (params, context) => {
    const tree = workingTree(context);
    const input = WorkingTreeReadRequestSchema.parse(params);
    return await tree.read(input.projectId, input.preferCached);
  },
  "git/working-tree/diff": async (params, context) => {
    const tree = workingTree(context);
    return await tree.diff(WorkingTreeFileRequestSchema.parse(params));
  },
  "git/working-tree/preview": async (params, context) => {
    const tree = workingTree(context);
    return await tree.preview(WorkingTreeFileRequestSchema.parse(params));
  },
  "git/working-tree/mutate": async (params, context) => {
    const tree = workingTree(context);
    return await tree.mutate(WorkingTreeMutationSchema.parse(params));
  },
  "git/push": async (params, { owners }) => {
    if (!owners.branchPositions) throw new Error("Pushing is unavailable.");
    const request = GitPushRequestSchema.safeParse(params);
    if (!request.success) throw new InvalidParamsError("A project ID is required to push.");
    return await owners.branchPositions.push(request.data.projectId);
  },
  "search/query": async (params, { owners }) => {
    // A newer app may send fields this daemon does not know; they drop instead of failing the search.
    const conformed = conformToZodSchema(WorkbenchSearchRequestSchema, { ...params, projectId: params.projectId === "" ? null : params.projectId });
    if (!conformed.success) throw new InvalidParamsError("Invalid search request.");
    const request = conformed.data;
    let projectId = request.projectId;
    if (projectId) {
      try {
        projectId = (await owners.projects.resolveProjectById(projectId)).id;
      } catch (error) {
        throw new InvalidParamsError(error instanceof Error ? error.message : "Unknown project.");
      }
    }
    return await owners.search.search({ ...request, projectId });
  },
  "native/file/open": async (params, { owners }) => await owners.nativeFiles.open(openFileRequest(params)),
  "native/file/reveal": async (params, { owners }) => await owners.nativeFiles.reveal({
    path: requiredString(params, "path"),
    projectId: requiredString(params, "projectId"),
  } satisfies RevealProjectEntryRequest),
  "native/file/link-roots": async (params, { owners }) => await owners.nativeFiles.linkRoots(linkRootsRequest(params)),
  "agents/list": async (params, { owners }) => await owners.agents.listAgents(requiredString(params, "projectId")),
  "agents/read": async (params, { owners }) => await owners.agents.readAgent(
    requiredString(params, "projectId"), requiredString(params, "agentPath"), requiredString(params, "provider"),
  ),
  "skills/read": async (params, { owners }) => await owners.agents.readSkills(
    typeof params.projectId === "string" ? params.projectId : null, requiredString(params, "provider"),
  ),
});
