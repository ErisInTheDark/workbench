/*
 * Exports:
 * - useWorkbenchClientMount: own async workspace-client mount/disposal and root-only explorer, startup and source-error reads.
 */
"use client";

import { startTransition, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { MountedWorkbenchClient } from "../../WorkbenchClient";
import type { ExplorerSnapshot } from "workbench-shared/types";
import ProjectTreeFileIndex from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import type WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import type WorkbenchAppRpcClient from "../../workbench/app/WorkbenchAppRpcClient";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchClientController } from "./workbench-client-context";
import { useWorkbenchWorkspace } from "./WorkbenchWorkspaceContext";

const INITIAL_EXPLORER_SNAPSHOT: ExplorerSnapshot = {
  changes: {},
  configuredDiscoveryRootPath: null,
  currentPath: "",
  currentProjectId: "",
  currentThreadId: "",
  expandedDirectories: [""],
  fontSize: 1.08,
  isProjectLoading: false,
  locallyModifiedPaths: [],
  projectFileCandidates: ProjectTreeFileIndex.empty.candidates,
  projectFileIndexId: ProjectTreeFileIndex.empty.id,
  projectFileIndexKey: ProjectTreeFileIndex.empty.key,
  projectFilePaths: ProjectTreeFileIndex.empty.paths,
  projects: [],
  root: "Project",
  rootPath: "",
  roots: [],
  tree: [],
  workbenchStorageRootPath: "",
};

const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};
const EMPTY_PROJECT_SOURCE_ERROR = () => "";
const INITIAL_PRESENTATION: ReturnType<NonNullable<MountedWorkbenchClient["presentationClient"]>["snapshot"]> = {
  phase: "idle", error: null, data: null,
};

interface WorkbenchClientMountOptions {
  appRpc: WorkbenchAppRpcClient | null;
  clientStateController: WorkbenchClientStateController;
  initialRoute: WorkbenchRoute;
}

export function useWorkbenchClientMount(options: WorkbenchClientMountOptions): {
  client: WorkbenchClientController;
  explorer: ExplorerSnapshot;
  startup: { phase: "loading" | "ready" | "failed"; error: string | null };
  projectSourceError: string;
} {
  const workspace = useWorkbenchWorkspace();
  const [mounted, setMounted] = useState<MountedWorkbenchClient | null>(null);
  const [mountError, setMountError] = useState<string | null>(null);
  const [explorer, setExplorer] = useState(INITIAL_EXPLORER_SNAPSHOT);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    let mountedClient: MountedWorkbenchClient | null = null;
    const timeoutId = window.setTimeout(() => {
      void import("../../WorkbenchClient").then(({ WorkbenchClient }) => {
        const current = optionsRef.current;
        const nextMounted = WorkbenchClient({
          workspace,
          appRpc: current.appRpc,
          clientStateController: current.clientStateController,
          initialRoute: current.initialRoute,
          onExplorerStateChange: (snapshot) => {
            if (cancelled) return;
            startTransition(() => {
              if (!cancelled) setExplorer(snapshot);
            });
          },
        });
        if (cancelled) {
          nextMounted.dispose();
          return;
        }
        mountedClient = nextMounted;
        setMounted(nextMounted);
      }).catch(error => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message.slice(0, 512)
          : "Workbench client could not mount.";
        setMountError(message);
        console.error("Workbench client could not mount:", message);
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      mountedClient?.dispose();
    };
  }, [options.clientStateController, workspace]);

  // The root reads presentation phase and data directly, so it re-renders on presentation changes.
  useSyncExternalStore(
    mounted?.presentationClient?.subscribe ?? EMPTY_SUBSCRIBE,
    mounted?.presentationClient?.snapshot ?? (() => INITIAL_PRESENTATION),
    () => INITIAL_PRESENTATION,
  );
  const projectSourceError = useSyncExternalStore(
    mounted?.projectSourceErrors.subscribe ?? EMPTY_SUBSCRIBE,
    mounted?.projectSourceErrors.getSnapshot ?? EMPTY_PROJECT_SOURCE_ERROR,
    EMPTY_PROJECT_SOURCE_ERROR,
  );
  const client = useMemo<WorkbenchClientController>(() => ({ controls: mounted?.controls ?? null, mounted }), [mounted]);
  const startup = useMemo(() => ({
    phase: mountError ? "failed" as const : mounted ? "ready" as const : "loading" as const, error: mountError,
  }), [mountError, mounted]);
  return { client, explorer, startup, projectSourceError };
}
