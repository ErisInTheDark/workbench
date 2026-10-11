/*
 * Exports:
 * - WorkbenchRouteContext: the route thread's owning view contexts, owner metadata, daemon, asset source and composer profile scope.
 * - useWorkbenchRouteContext: resolve the route context from the mounted client, re-rendering only when what it resolves to changes.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { ThreadPayload } from "workbench-shared/types";
import { getWorkbenchThreadTargetRootId, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchClientController } from "../../components/workbench/workbench-client-context";

const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};

function resolve(client: WorkbenchClientController, route: WorkbenchRoute, currentThread: ThreadPayload | null,
  browseLocation: ProjectLocationReference | null) {
  const mounted = client.mounted;
  const existingThreadId = route.view === "thread" && route.logical
    && (route.threadTarget?.kind === "provider" || route.threadTarget?.kind === "subagent")
    ? getWorkbenchThreadTargetRootId(route.threadTarget) : null;
  const threadContext = existingThreadId ? mounted?.threadContextFor(existingThreadId) ?? null : null;
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
  const ownerMetadata = existingThreadId ? mounted?.threadOwnerFor(existingThreadId) ?? null : null;
  const attachedDaemonId = mounted?.networkClient?.snapshot().snapshot?.daemon?.daemonId ?? null;
  return { existingThreadId, threadContext, draftId, draftContext, launchLocation, ownerMetadata, attachedDaemonId };
}

/** Cache key over every plain fact the context resolves to; daemon clients are rebuilt from it. */
function contextKey(resolved: ReturnType<typeof resolve>) {
  const view = (context: ReturnType<typeof resolve>["draftContext"]) => context
    ? { daemonId: context.daemonId, project: context.project, registrationId: "registrationId" in context ? context.registrationId : null }
    : null;
  return JSON.stringify({
    ...resolved, threadContext: view(resolved.threadContext), draftContext: view(resolved.draftContext),
  });
}

export function useWorkbenchRouteContext(client: WorkbenchClientController, route: WorkbenchRoute,
  currentThread: ThreadPayload | null, browseLocation: ProjectLocationReference | null) {
  const mounted = client.mounted;
  const readKey = useCallback(() => contextKey(resolve(client, route, currentThread, browseLocation)),
    [browseLocation, client, currentThread, route]);
  const key = useSyncExternalStore(mounted?.subscribeChanges ?? EMPTY_SUBSCRIBE, readKey, readKey);
  const controls = client.controls;
  const browseDaemon = useMemo(() => browseLocation
    ? mounted?.workspace.daemon({ kind: "folder", location: browseLocation }) ?? null
    : route.logical ? null : controls?.daemon ?? null,
  [mounted, browseLocation?.daemonId, browseLocation?.projectId, Boolean(route.logical), controls]);
  // `key` stands for every resolved fact, so a change the route inputs don't show still rebuilds the context.
  return useMemo(() => {
    const resolved = resolve(client, route, currentThread, browseLocation);
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
