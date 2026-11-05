/*
 * Exports:
 * - WorkbenchRouteContext: the shown thread's (or draft's) owning view contexts, owner metadata, daemon, asset source and composer profile scope, plus the root thread's context.
 * - resolveWorkbenchRouteContext: read a route's plain context facts; a shown subagent uses its own owner, its root standing in until that lands.
 * - useWorkbenchRouteContext: resolve the route context from the mounted client, re-rendering only when what it resolves to changes.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { ThreadPayload } from "workbench-shared/types";
import {
  getWorkbenchThreadTargetRootId, getWorkbenchThreadTargetSelectedId, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchClientController } from "../../components/workbench/workbench-client-context";

const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};

export function resolveWorkbenchRouteContext(client: WorkbenchClientController, route: WorkbenchRoute, currentThread: ThreadPayload | null) {
  const mounted = client.mounted;
  const existingTarget = route.view === "thread" && route.logical
    && (route.threadTarget?.kind === "provider" || route.threadTarget?.kind === "subagent") ? route.threadTarget : null;
  const existingThreadId = existingTarget ? getWorkbenchThreadTargetRootId(existingTarget) : null;
  const shownThreadId = existingTarget ? getWorkbenchThreadTargetSelectedId(existingTarget) : null;
  const rootContext = existingThreadId ? mounted?.threadContextFor(existingThreadId) ?? null : null;
  const threadContext = (shownThreadId ? mounted?.threadContextFor(shownThreadId) : null) ?? rootContext;
  const draftId = route.view === "thread" && route.logical
    ? route.threadTarget?.kind === "draft" ? route.threadTarget.draftId
      : route.threadTarget?.kind === "new" && currentThread?.isDraft ? currentThread.id : null
    : null;
  const draftContext = draftId ? mounted?.draftContextFor(draftId) ?? null : null;
  const launchLocation = route.view === "thread" && route.logical && route.threadTarget?.kind === "draft"
    ? mounted?.presentationClient?.draft(route.threadTarget.draftId)?.target
      ?? mounted?.draftLocationFor(route.threadTarget.draftId) ?? null
    : route.view === "thread" && route.logical && route.threadTarget?.kind === "new"
      ? currentThread?.isDraft ? mounted?.draftLocationFor(currentThread.id) ?? null : null
      : null;
  const ownerMetadata = existingThreadId
    ? (shownThreadId ? mounted?.threadOwnerFor(shownThreadId) : null) ?? mounted?.threadOwnerFor(existingThreadId) ?? null
    : launchLocation ? mounted?.locationOwnerFor(launchLocation) ?? null : null;
  const attachedDaemonId = mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId ?? null;
  return { existingThreadId, shownThreadId, rootContext, threadContext, draftId, draftContext, launchLocation, ownerMetadata, attachedDaemonId };
}

/** Cache key over every plain fact the context resolves to; daemon clients are rebuilt from it. */
function contextKey(resolved: ReturnType<typeof resolveWorkbenchRouteContext>) {
  const view = (context: ReturnType<typeof resolveWorkbenchRouteContext>["draftContext"]) => context
    ? { daemonId: context.daemonId, project: context.project, registrationId: "registrationId" in context ? context.registrationId : null }
    : null;
  return JSON.stringify({
    ...resolved, rootContext: view(resolved.rootContext), threadContext: view(resolved.threadContext), draftContext: view(resolved.draftContext),
  });
}

export function useWorkbenchRouteContext(client: WorkbenchClientController, route: WorkbenchRoute,
  currentThread: ThreadPayload | null, browseLocation: ProjectLocationReference | null) {
  const mounted = client.mounted;
  const readKey = useCallback(() => contextKey(resolveWorkbenchRouteContext(client, route, currentThread)),
    [client, currentThread, route]);
  const key = useSyncExternalStore(mounted?.subscribeChanges ?? EMPTY_SUBSCRIBE, readKey, readKey);
  const controls = client.controls;
  const browseDaemon = useMemo(() => browseLocation
    ? mounted?.workspace.daemon({ kind: "folder", location: browseLocation }) ?? null
    : route.logical ? null : controls?.daemon ?? null,
  [mounted, browseLocation?.daemonId, browseLocation?.projectId, Boolean(route.logical), controls]);
  // `key` stands for every resolved fact, so a change the route inputs don't show still rebuilds the context.
  return useMemo(() => {
    const resolved = resolveWorkbenchRouteContext(client, route, currentThread);
    const selectedDaemon = resolved.existingThreadId
      ? resolved.threadContext?.daemon ?? null
      : resolved.draftContext?.daemon ?? (route.view === "thread" && route.logical
        ? resolved.launchLocation ? mounted?.launchContextFor(resolved.launchLocation)?.daemon ?? null : null
        : browseDaemon);
    const selectedAssetSource = resolved.existingThreadId
      ? resolved.threadContext?.assetSource ?? { kind: "unavailable" as const }
      : resolved.draftContext?.assetSource ?? (browseLocation
        ? { kind: "source" as const, daemonId: browseLocation.daemonId }
        : { kind: "unavailable" as const });
    const profileScopeKey = resolved.threadContext?.daemonId ?? resolved.draftContext?.daemonId
      ?? resolved.launchLocation?.daemonId ?? resolved.attachedDaemonId ?? "attached";
    return { ...resolved, browseDaemon, selectedDaemon, selectedAssetSource, profileScopeKey };
  }, [key, browseDaemon, browseLocation, client, currentThread, mounted, route]);
}

export type WorkbenchRouteContext = ReturnType<typeof useWorkbenchRouteContext>;
