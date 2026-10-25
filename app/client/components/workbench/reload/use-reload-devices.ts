/*
 * Exports:
 * - ReloadDevicePorts: the reload and update intents one device's controls send.
 * - ReloadDeviceState: one device's reload plan, controls and progress, as the reload panel and the footer pill show it.
 * - ReloadSources: the attached daemon, this device's name, every other reachable daemon and the shared operation.
 * - useReloadSources: read ReloadSources from the mounted client.
 * - useLocalReloadDevice: this device's merged app and daemon dirt, update, controls and agent resolve.
 * - useRemoteReloadDevices: every other daemon's dirt, update and controls, one runtime client each.
 * - useReloadRequest: send one control intent at a time, keeping its failure message until the next send.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import {
  IDLE_DEVICE_RELOAD_OPERATION, type DeviceReloadOperation,
} from "workbench-shared/reload/device-reload-operation";
import { partitionReloadScopes } from "workbench-shared/reload/reload-scope-partition";
import type { WorkbenchAppRuntimeStore, WorkbenchDaemonRuntimeStore, WorkbenchReloadDirtScope } from "workbench-shared/types";
import { DaemonIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type { WorkspaceDaemonFact } from "workbench-shared/workbench/workspace/workspace-observation";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import type WorkbenchWorkspaceClient from "../../../workbench/app/WorkbenchWorkspaceClient";
import { useWorkbenchAppConnectionInterrupted } from "../../../workbench/app/WorkbenchAppRpcContext";
import WorkbenchDaemonRuntimeClient from "../../../workbench/WorkbenchDaemonRuntimeClient";
import { useWorkbenchClientController } from "../workbench-client-context";
import { mergeReloadDirt, planReloadDevice, type ReloadDevicePlan } from "./reload-device";
import { updateConflictPrompt, updateFailurePrompt } from "./update-issue-prompts";

type AskAgent = (projectId: string, references: readonly PresentationDraftReference[]) => void;

export interface ReloadDevicePorts {
  reloadScope(scope: WorkbenchReloadDirtScope): Promise<unknown>;
  reloadAll(): Promise<unknown>;
  pull(reload: boolean): Promise<unknown>;
}

export interface ReloadDeviceState {
  key: string;
  name: string;
  local: boolean;
  plan: ReloadDevicePlan;
  ports: ReloadDevicePorts;
  /** The running operation's label when it targets this device. */
  running: string | null;
  /** Another operation runs or the app connection dropped, so no control may start. */
  disabled: boolean;
  error: string | null;
  pendingScopes: readonly string[];
  /** Why this device cannot be reached; it shows instead of controls. */
  unavailable: string | null;
  /** Hands an update conflict or failure to an agent; null where only that device can. */
  resolve: (() => void) | null;
}

export interface ReloadSources {
  attachedId: DaemonId | null;
  localName: string;
  remotes: readonly WorkspaceDaemonFact[];
  operation: DeviceReloadOperation;
  interrupted: boolean;
  tabOutOfDate: boolean;
  /** A pull runs; the tab refreshes itself afterwards, so "out of date" is not worth showing meanwhile. */
  pullRunning: boolean;
}

const NO_SUBSCRIPTION = () => () => undefined;
const OPERATION_LABELS: Partial<Record<DeviceReloadOperation["phase"], string>> = {
  pulling: "Pulling", waiting: "Reloading", reloading: "Reloading", restarting: "Restarting",
};
const PULL_ACTIONS = new Set<DeviceReloadOperation["action"]>(["pull", "pullAndReload"]);

const isRunning = (operation: DeviceReloadOperation) => operation.phase !== "idle" && operation.phase !== "failed";

/** A reload that replaces the process serving the request drops it; reconnected facts decide the outcome. */
function ignoringInterruption(send: () => Promise<unknown>) {
  return async () => {
    try { await send(); }
    catch (error) {
      if (error instanceof WorkbenchRpcRequestInterruptedError || error instanceof TypeError) return;
      throw error;
    }
  };
}

function operationFor(sources: ReloadSources, daemonId: DaemonId | null) {
  const target = sources.operation.daemonId ?? sources.attachedId;
  return (target ?? null) === daemonId ? sources.operation : null;
}

function runningLabel(mine: DeviceReloadOperation | null, interrupted: boolean) {
  if (!mine || !isRunning(mine)) return null;
  return interrupted ? "Reconnecting" : OPERATION_LABELS[mine.phase] ?? "Updating";
}

function useAppRuntimeSnapshot(appRuntime: WorkbenchAppRuntimeStore | null) {
  return useSyncExternalStore(appRuntime?.subscribe ?? NO_SUBSCRIPTION,
    () => appRuntime?.getSnapshot() ?? null, () => appRuntime?.getSnapshot() ?? null);
}

export function useReloadSources(appRuntime: WorkbenchAppRuntimeStore | null): ReloadSources {
  const mounted = useWorkbenchClientController().mounted;
  const facts = mounted?.projectFacts ?? null;
  const sources = useSyncExternalStore(facts?.subscribe ?? NO_SUBSCRIPTION,
    () => facts?.getData()?.sources ?? null, () => facts?.getData()?.sources ?? null);
  const network = mounted?.networkClient ?? null;
  const networkState = useSyncExternalStore(network?.subscribe ?? NO_SUBSCRIPTION,
    () => network?.snapshot() ?? null, () => network?.snapshot() ?? null);
  const readOperation = () => appRuntime?.getOperation() ?? IDLE_DEVICE_RELOAD_OPERATION;
  const operation = useSyncExternalStore(appRuntime?.subscribeOperation ?? NO_SUBSCRIPTION, readOperation, readOperation);
  const interrupted = useWorkbenchAppConnectionInterrupted();
  const tabOutOfDate = useSyncExternalStore(appRuntime?.subscribe ?? NO_SUBSCRIPTION,
    () => appRuntime?.getSnapshot().tabOutOfDate ?? false, () => false);
  const attached = networkState?.snapshot?.daemon?.daemonId;
  const attachedId = attached ? DaemonIdSchema.parse(attached) : null;
  const remotes = useMemo(() => (sources ?? [])
    .filter(source => source.daemonId !== attachedId && source.connection !== "revoked")
    .sort((left, right) => left.hostname.localeCompare(right.hostname)), [attachedId, sources]);
  return {
    attachedId,
    localName: sources?.find(source => source.daemonId === attachedId)?.hostname ?? "This device",
    remotes,
    operation,
    interrupted,
    tabOutOfDate,
    pullRunning: PULL_ACTIONS.has(operation.action) && isRunning(operation),
  };
}

/** A pull & reload started here refreshes this tab once the app settles: connected, idle and nothing pending. */
function useRefreshAfterUpdate(appRuntime: WorkbenchAppRuntimeStore | null, operation: DeviceReloadOperation) {
  const interrupted = useWorkbenchAppConnectionInterrupted();
  const runtime = useAppRuntimeSnapshot(appRuntime);
  const [awaiting, setAwaiting] = useState(false);
  const sawOperation = useRef(false);
  useEffect(() => {
    if (!awaiting) return;
    if (operation.phase !== "idle") {
      sawOperation.current = true;
      if (operation.phase === "failed") setAwaiting(false);
      return;
    }
    if (!sawOperation.current || interrupted || runtime?.pendingScopes.length) return;
    if (runtime?.tabOutOfDate) window.location.reload();
    else setAwaiting(false);
  }, [awaiting, interrupted, operation.phase, runtime?.pendingScopes.length, runtime?.tabOutOfDate]);
  return () => { sawOperation.current = false; setAwaiting(true); };
}

export function useLocalReloadDevice({ appRuntime, daemonRuntime, sources, onAskAgent }: {
  appRuntime: WorkbenchAppRuntimeStore | null;
  daemonRuntime: WorkbenchDaemonRuntimeStore | null;
  sources: ReloadSources;
  onAskAgent: AskAgent;
}): ReloadDeviceState {
  const appDirt = useAppRuntimeSnapshot(appRuntime);
  const daemonDirt = useSyncExternalStore(daemonRuntime?.subscribe ?? NO_SUBSCRIPTION,
    () => daemonRuntime?.getSnapshot() ?? null, () => daemonRuntime?.getSnapshot() ?? null);
  const update = useSyncExternalStore(daemonRuntime?.subscribeUpdate ?? NO_SUBSCRIPTION,
    () => daemonRuntime?.getUpdate() ?? null, () => daemonRuntime?.getUpdate() ?? null);
  const awaitRefresh = useRefreshAfterUpdate(appRuntime, sources.operation);
  const [issueError, setIssueError] = useState("");
  const dirt = mergeReloadDirt(appDirt, daemonDirt);
  const mine = operationFor(sources, sources.attachedId);
  const ports: ReloadDevicePorts = {
    reloadScope: scope => ignoringInterruption(async () => {
      const owners = partitionReloadScopes([scope.scope]);
      await Promise.all([
        owners.client.length ? appRuntime?.reloadScopes(owners.client)
          ?? Promise.reject(new Error("Workbench app reload controls are not ready.")) : undefined,
        owners.server.length ? daemonRuntime?.reloadScopes(owners.server)
          ?? Promise.reject(new Error("Workbench daemon reload controls are not ready.")) : undefined,
      ]);
    })(),
    reloadAll: ignoringInterruption(async () => {
      if (!appRuntime) throw new Error("Workbench app reload controls are not ready.");
      await appRuntime.reloadAll();
    }),
    pull: async reload => {
      if (!appRuntime) throw new Error("Workbench app update controls are not ready.");
      if (reload) awaitRefresh();
      await ignoringInterruption(() => appRuntime.pull({ reload }))();
    },
  };
  const projectId = update?.projectId;
  const resolve = projectId ? () => {
    setIssueError("");
    if (update.failure) {
      onAskAgent(projectId, [{ kind: "updateIssue", text: updateFailurePrompt(update, update.failure) }]);
      // The repair breadcrumb has done its job once an agent has the log.
      void daemonRuntime?.dismissUpdateFailure().catch((error: unknown) => {
        setIssueError(error instanceof Error ? error.message : "Unable to clear the failed update record.");
      });
    } else {
      onAskAgent(projectId, [{ kind: "updateIssue", text: updateConflictPrompt(update) }]);
    }
  } : null;
  return {
    key: sources.attachedId ?? "local",
    name: sources.localName,
    local: true,
    plan: planReloadDevice({ local: true, dirt, update, appUpdateScopes: appDirt?.updateScopes ?? null }),
    ports,
    running: runningLabel(mine, sources.interrupted),
    disabled: isRunning(sources.operation) || sources.interrupted,
    error: issueError || (mine?.phase === "failed" ? mine.error : null) || dirt?.error || null,
    pendingScopes: dirt?.pendingScopes ?? [],
    unavailable: null,
    resolve,
  };
}

interface RemoteFacts {
  source: WorkspaceDaemonFact;
  runtime: WorkbenchDaemonRuntimeClient;
  dirt: ReturnType<WorkbenchDaemonRuntimeClient["getSnapshot"]>;
  update: ReturnType<WorkbenchDaemonRuntimeClient["getUpdate"]>;
}

/** One runtime client per remote daemon, opened while mounted; workspace interests are shared across observers. */
function useRemoteFacts(workspace: WorkbenchWorkspaceClient | null, remotes: readonly WorkspaceDaemonFact[]) {
  const ids = remotes.map(source => source.daemonId).join(",");
  const runtimes = useMemo(() => new Map(workspace && ids
    ? ids.split(",").map(id => {
      const daemonId = DaemonIdSchema.parse(id);
      return [daemonId, new WorkbenchDaemonRuntimeClient({ workspace, daemonId })] as const;
    })
    : []), [ids, workspace]);
  useEffect(() => {
    for (const runtime of runtimes.values()) void runtime.open();
    return () => { for (const runtime of runtimes.values()) runtime.dispose(); };
  }, [runtimes]);
  const subscribe = useCallback((listener: () => void) => {
    const releases = [...runtimes.values()].flatMap(runtime => [runtime.subscribe(listener), runtime.subscribeUpdate(listener)]);
    return () => { for (const release of releases) release(); };
  }, [runtimes]);
  const cache = useRef<readonly RemoteFacts[]>([]);
  const read = () => {
    const next = remotes.flatMap(source => {
      const runtime = runtimes.get(source.daemonId);
      return runtime ? [{ source, runtime, dirt: runtime.getSnapshot(), update: runtime.getUpdate() }] : [];
    });
    const previous = cache.current;
    const same = previous.length === next.length && previous.every((facts, index) => facts.source === next[index]?.source
      && facts.runtime === next[index].runtime && facts.dirt === next[index].dirt && facts.update === next[index].update);
    if (!same) cache.current = next;
    return cache.current;
  };
  return useSyncExternalStore(subscribe, read, read);
}

function offline(source: WorkspaceDaemonFact) {
  if (source.connection === "current") return null;
  if (source.connection === "sleeping") return "asleep";
  return source.connection === "connecting" || source.connection === "reconnecting" ? "connecting" : "unavailable";
}

export function useRemoteReloadDevices({ appRuntime, sources }: {
  appRuntime: WorkbenchAppRuntimeStore | null;
  sources: ReloadSources;
}): ReloadDeviceState[] {
  const workspace = useWorkbenchClientController().mounted?.workspace ?? null;
  return useRemoteFacts(workspace, sources.remotes).map(({ source, runtime, dirt, update }) => {
    const daemonId = source.daemonId;
    const mine = operationFor(sources, daemonId);
    return {
      key: daemonId,
      name: source.hostname,
      local: false,
      plan: planReloadDevice({ local: false, dirt, update }),
      ports: {
        reloadScope: scope => ignoringInterruption(() => runtime.reloadScopes([scope.scope]))(),
        reloadAll: async () => {
          if (!appRuntime) throw new Error("Workbench app reload controls are not ready.");
          await appRuntime.reloadAll({ daemonId });
        },
        pull: async reload => {
          if (!appRuntime) throw new Error("Workbench app update controls are not ready.");
          await appRuntime.pull({ reload, daemonId });
        },
      },
      running: runningLabel(mine, false),
      disabled: isRunning(sources.operation) || sources.interrupted,
      error: (mine?.phase === "failed" ? mine.error : null) || dirt.error || null,
      pendingScopes: dirt.pendingScopes,
      unavailable: offline(source),
      resolve: null,
    };
  });
}

export function useReloadRequest() {
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const request = (send: () => Promise<unknown>) => {
    setError("");
    setRequesting(true);
    void send().catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : "The reload request failed.");
    }).finally(() => setRequesting(false));
  };
  return { request, requesting, error };
}
