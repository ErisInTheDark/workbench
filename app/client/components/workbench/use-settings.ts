/*
 * Exports:
 * - useSettings: global or explicit-project preferences with typed get/set/reset; project, forLocation and forThread bind owners, fileOpenPolicy reads event targets.
 */
"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import { WORKBENCH_FILE_OPEN_SETTING_KEYS } from "workbench-shared/workbench/settings/workbench-setting-definitions";
import {
  readGlobalWorkbenchSettings,
  readLogicalProjectWorkbenchSettings,
  resolveWorkbenchSettings,
  writeGlobalWorkbenchSetting,
  writeLogicalProjectWorkbenchSetting,
  type WorkbenchGlobalSettings,
  type WorkbenchSettingKey,
} from "../../workbench/state/workbench-settings";
import { useWorkbenchClientStateController } from "./workbench-client-state-context";
import { useWorkbenchClientController, type WorkbenchClientController } from "./workbench-client-context";
import { useProjects } from "./use-projects";

/** Settings whose app-state rows arrived after logical-project preferences; older databases cannot store them. */
const KEY_RELEASES: Partial<Record<WorkbenchSettingKey, number>> = {
  gitPeerSyncMode: appStateReleases.gitPeerSyncMode.version,
  openMarkdownFilesWith: appStateReleases.fileOpenDestinations.version,
  openOtherFilesWith: appStateReleases.fileOpenDestinations.version,
  openSvgFilesWith: appStateReleases.fileOpenDestinations.version,
  threadCodeDetails: appStateReleases.threadCodeDetails.version,
  userName: appStateReleases.userName.version,
};

function useBoundSettings(logicalProjectId: LogicalProjectId | null, unresolved = false) {
  const controller = useWorkbenchClientStateController();
  const select = useCallback(() => {
    const state = controller.getSnapshot();
    const project = readLogicalProjectWorkbenchSettings(logicalProjectId, state.records);
    return { project, values: resolveWorkbenchSettings(readGlobalWorkbenchSettings(state.records), project),
      schemaVersion: state.schemaVersion };
  }, [controller, logicalProjectId]);
  const retained = useRef<ReturnType<typeof select> | null>(null);
  const read = useCallback(() => {
    const next = select();
    if (!retained.current || !areDeeplyEqual(retained.current, next)) retained.current = next;
    return retained.current;
  }, [select]);
  const snapshot = useSyncExternalStore(controller.subscribe, read, read);
  const unavailable = useCallback((key: WorkbenchSettingKey) => unresolved || snapshot.schemaVersion < Math.max(
      KEY_RELEASES[key] ?? 0,
      logicalProjectId ? appStateReleases.logicalProjectPreferences.version : 0,
    ), [logicalProjectId, snapshot.schemaVersion, unresolved]);
  return useMemo(() => ({
    projectId: logicalProjectId,
    get<K extends WorkbenchSettingKey>(key: K): WorkbenchGlobalSettings[K] { return snapshot.values[key]; },
    overridden: (key: WorkbenchSettingKey) => Boolean(logicalProjectId && snapshot.project[key].enabled),
    unavailable,
    async set<K extends WorkbenchSettingKey>(key: K, value: WorkbenchGlobalSettings[K]) {
      if (unavailable(key)) throw new Error("The settings owner or schema is unavailable.");
      await (logicalProjectId
        ? writeLogicalProjectWorkbenchSetting(controller, logicalProjectId, key, { enabled: true, value })
        : writeGlobalWorkbenchSetting(controller, key, value));
    },
    async reset(key: WorkbenchSettingKey) {
      if (unavailable(key)) throw new Error("The settings owner or schema is unavailable.");
      if (!logicalProjectId) return;
      const project = readLogicalProjectWorkbenchSettings(logicalProjectId, controller.getSnapshot().records);
      await writeLogicalProjectWorkbenchSetting(controller, logicalProjectId, key, { ...project[key], enabled: false });
    },
  }), [controller, logicalProjectId, snapshot, unavailable]);
}

export function useSettings(logicalProjectId: LogicalProjectId | null = null) {
  return useBoundSettings(logicalProjectId);
}

useSettings.project = function useProjectSettings(logicalProjectId: LogicalProjectId | null) {
  return useBoundSettings(logicalProjectId, !logicalProjectId);
};

useSettings.forLocation = function useLocationSettings(location: ProjectLocationReference | null,
  explicitClient?: WorkbenchClientController) {
  const client = useWorkbenchClientController(explicitClient);
  useProjects(client);
  const project = location ? client.mounted?.projectFacts.getForLocation(location) : null;
  return useBoundSettings(project?.id ?? null, !project);
};

const EMPTY_SUBSCRIBE = () => () => {};

useSettings.forThread = function useThreadSettings(target: WorkbenchThreadRouteTarget | null,
  launchLocation: ProjectLocationReference | null = null, explicitClient?: WorkbenchClientController) {
  const client = useWorkbenchClientController(explicitClient);
  useProjects(client);
  const mounted = client.mounted;
  const readOwner = useCallback(() => {
    const id = target?.kind === "provider" ? target.threadId : target?.kind === "subagent"
      ? target.parentThreadId : target?.kind === "draft" ? target.draftId : null;
    const location = target?.kind === "draft" && id ? mounted?.draftLocationFor(id)
      : id ? mounted?.threadOwnerFor(id) : launchLocation;
    return location ? mounted?.projectFacts.getForLocation(location)?.id ?? null : null;
  }, [launchLocation, mounted, target]);
  const owner = useSyncExternalStore(mounted?.subscribeChanges ?? EMPTY_SUBSCRIBE, readOwner, readOwner);
  return useBoundSettings(owner, !owner);
};

useSettings.fileOpenPolicy = function useFileOpenPolicy(explicitClient?: WorkbenchClientController) {
  const client = useWorkbenchClientController(explicitClient);
  const controller = useWorkbenchClientStateController();
  const projects = useProjects(client);
  const readPolicyKey = useCallback(() => JSON.stringify(controller.getSnapshot().records.filter(record =>
    (record.kind === "globalPreference" || record.kind === "logicalProjectPreference")
    && (record.preference.key === "fileOpenBehavior"
      || Object.values(WORKBENCH_FILE_OPEN_SETTING_KEYS).some(key => key === record.preference.key)))),
  [controller]);
  const policyKey = useSyncExternalStore(controller.subscribe, readPolicyKey, readPolicyKey);
  return useCallback((location: ProjectLocationReference | null) => {
    const project = location ? client.mounted?.projectFacts.getForLocation(location) : null;
    const records = controller.getSnapshot().records;
    const settings = resolveWorkbenchSettings(readGlobalWorkbenchSettings(records),
      readLogicalProjectWorkbenchSettings(project?.id ?? null, records));
    return { openMarkdownFilesWith: settings.openMarkdownFilesWith, openOtherFilesWith: settings.openOtherFilesWith,
      openSvgFilesWith: settings.openSvgFilesWith };
  }, [client, controller, projects, policyKey]);
};
