/*
 * Exports:
 * - default conformWorkbenchThreadStateOpenResult: repair inbound browser bootstrap display state without writing repaired data back to the server. Keywords: browser, sidebar, schema, conformance, read-only.
 * - conformWorkbenchGlobalThreadStateOpenResult: repair global bootstrap state and strip retired arc reload scopes. Keywords: browser, global, compatibility, read-only.
 * - conformWorkbenchThreadStateSnapshot: repair pushed sidebar state and strip retired arc reload scopes. Keywords: browser, notification, compatibility, read-only.
 */

import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  WorkbenchGlobalThreadStateOpenResultSchema,
  WorkbenchProjectThreadSidebarUpdateSchema,
  WorkbenchThreadSidebarSnapshotSchema,
  WorkbenchThreadStateOpenResultSchema,
  WorkbenchThreadStateSnapshotSchema,
  type WorkbenchThreadStateSnapshot,
} from "workbench-shared/workbench/thread/thread-state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripRetiredReloadScopes(value: unknown, path: PropertyKey[] = [], repairedPaths: PropertyKey[][] = []): {
  repairedPaths: PropertyKey[][];
  value: unknown;
} {
  if (Array.isArray(value)) {
    return {
      repairedPaths,
      value: value.map((entry, index) => stripRetiredReloadScopes(entry, [...path, index], repairedPaths).value),
    };
  }
  if (!isRecord(value)) return { repairedPaths, value };
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "reloadScopes") {
      repairedPaths.push([...path, key]);
      continue;
    }
    result[key] = stripRetiredReloadScopes(entry, [...path, key], repairedPaths).value;
  }
  return { repairedPaths, value: result };
}

function mergeRepairs(left: PropertyKey[][], right: PropertyKey[][]) {
  return [...left, ...right];
}

export default function conformWorkbenchThreadStateOpenResult(value: unknown, projectId: string) {
  const stripped = stripRetiredReloadScopes(value);
  const conformed = conformToZodSchema(WorkbenchThreadStateOpenResultSchema, stripped.value, {
    catalog: { data: [], rootPath: "" },
    project: null,
    sidebar: {
      entries: [],
      error: "The thread-state bootstrap response needed compatibility repair.",
      freshness: "partial",
      projectId,
      revision: 0,
    },
  });
  return { ...conformed, repairedPaths: mergeRepairs(stripped.repairedPaths, conformed.repairedPaths) };
}

export function conformWorkbenchGlobalThreadStateOpenResult(value: unknown) {
  const stripped = stripRetiredReloadScopes(value);
  const conformed = conformToZodSchema(WorkbenchGlobalThreadStateOpenResultSchema, stripped.value, {
    catalog: { data: [], rootPath: "" },
    homeThreadDisplayOrder: {
      displayOrder: {},
      revision: 0,
      updateKind: "homeThreadDisplayOrder",
    },
    pinnedThreadLayout: {
      displayOrder: {},
      revision: 0,
      updateKind: "pinnedThreadLayout",
    },
    projectSidebars: { projects: [] },
    version: 6,
  });
  return { ...conformed, repairedPaths: mergeRepairs(stripped.repairedPaths, conformed.repairedPaths) };
}

export function conformWorkbenchThreadStateSnapshot(value: unknown): {
  data: WorkbenchThreadStateSnapshot | null;
  repairedPaths: PropertyKey[][];
} {
  const stripped = stripRetiredReloadScopes(value);
  const parsed = WorkbenchThreadStateSnapshotSchema.safeParse(stripped.value);
  if (parsed.success) return { data: parsed.data, repairedPaths: stripped.repairedPaths };

  if (isRecord(stripped.value) && Array.isArray(stripped.value.entries)) {
    const projectId = typeof stripped.value.projectId === "string" && stripped.value.projectId ? stripped.value.projectId : "unknown";
    const conformed = conformToZodSchema(WorkbenchThreadSidebarSnapshotSchema, stripped.value, {
      entries: [],
      error: "The pushed thread-state sidebar needed compatibility repair.",
      freshness: "partial",
      projectId,
      revision: 0,
    });
    return { data: conformed.data, repairedPaths: mergeRepairs(stripped.repairedPaths, conformed.repairedPaths) };
  }

  if (isRecord(stripped.value) && stripped.value.updateKind === "projectThreadSidebar") {
    const sidebar = isRecord(stripped.value.sidebar) ? stripped.value.sidebar : {};
    const projectId = typeof sidebar.projectId === "string" && sidebar.projectId ? sidebar.projectId : "unknown";
    const conformed = conformToZodSchema(WorkbenchProjectThreadSidebarUpdateSchema, stripped.value, {
      sidebar: {
        entries: [],
        error: "The pushed project sidebar needed compatibility repair.",
        freshness: "partial",
        projectId,
        revision: 0,
      },
      updateKind: "projectThreadSidebar",
    });
    return { data: conformed.data, repairedPaths: mergeRepairs(stripped.repairedPaths, conformed.repairedPaths) };
  }

  return { data: null, repairedPaths: mergeRepairs(stripped.repairedPaths, [[]]) };
}
