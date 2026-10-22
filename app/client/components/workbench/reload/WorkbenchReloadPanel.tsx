/*
 * Exports:
 * - default WorkbenchReloadPanel: the sidebar's reload and update panel: this device first, then every other daemon this app
 *   reaches, each with its own reload tree, update and impact, plus the stale-tab refresh.
 */
"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import {
  IDLE_DEVICE_RELOAD_OPERATION, type DeviceReloadOperation as WorkbenchReloadOperation,
} from "workbench-shared/reload/device-reload-operation";
import { partitionReloadScopes } from "workbench-shared/reload/reload-scope-partition";
import type { WorkbenchAppRuntimeStore, WorkbenchDaemonRuntimeStore } from "workbench-shared/types";
import { DaemonIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type { WorkspaceDaemonFact } from "workbench-shared/workbench/workspace/workspace-observation";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import { useWorkbenchAppConnectionInterrupted } from "../../../workbench/app/WorkbenchAppRpcContext";
import WorkbenchDaemonRuntimeClient from "../../../workbench/WorkbenchDaemonRuntimeClient";
import PrimaryButton from "../../ui/PrimaryButton";
import { useWorkbenchClientController } from "../workbench-client-context";
import { mergeReloadDirt, planReloadDevice } from "./reload-device";
import { updateConflictPrompt, updateFailurePrompt } from "./update-issue-prompts";
import WorkbenchReloadDevice, { type WorkbenchReloadDevicePorts } from "./WorkbenchReloadDevice";

type AskAgent = (projectId: string, references: readonly PresentationDraftReference[]) => void;

const NO_SUBSCRIPTION = () => () => undefined;
const SIDEBAR_BUTTON = "!shrink-0 [&>span:first-of-type]:!inset-[3px]";
const OPERATION_LABELS: Partial<Record<WorkbenchReloadOperation["phase"], string>> = {
  pulling: "Pulling", waiting: "Reloading", reloading: "Reloading", restarting: "Restarting",
};
const PULL_ACTIONS = new Set<WorkbenchReloadOperation["action"]>(["pull", "pullAndReload"]);

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

const running = (operation: WorkbenchReloadOperation) => operation.phase !== "idle" && operation.phase !== "failed";

function useOperation(appRuntime: WorkbenchAppRuntimeStore | null) {
  const read = () => appRuntime?.getOperation() ?? IDLE_DEVICE_RELOAD_OPERATION;
  return useSyncExternalStore(appRuntime?.subscribeOperation ?? NO_SUBSCRIPTION, read, read);
}

function useDaemonFacts(runtime: Pick<WorkbenchDaemonRuntimeStore, "getSnapshot" | "subscribe" | "getUpdate" | "subscribeUpdate"> | null) {
  const dirt = useSyncExternalStore(runtime?.subscribe ?? NO_SUBSCRIPTION,
    () => runtime?.getSnapshot() ?? null, () => runtime?.getSnapshot() ?? null);
  const update = useSyncExternalStore(runtime?.subscribeUpdate ?? NO_SUBSCRIPTION,
    () => runtime?.getUpdate() ?? null, () => runtime?.getUpdate() ?? null);
  return { dirt, update };
}

/** A pull & reload started here refreshes this tab once the app settles: connected, idle and nothing pending. */
function useRefreshAfterUpdate(appRuntime: WorkbenchAppRuntimeStore | null, operation: WorkbenchReloadOperation) {
  const interrupted = useWorkbenchAppConnectionInterrupted();
  const runtime = useSyncExternalStore(appRuntime?.subscribe ?? NO_SUBSCRIPTION,
    () => appRuntime?.getSnapshot() ?? null, () => appRuntime?.getSnapshot() ?? null);
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

function deviceOperation(operation: WorkbenchReloadOperation, daemonId: DaemonId | null, attachedId: DaemonId | null) {
  const target = operation.daemonId ?? attachedId;
  return (target ?? null) === daemonId ? operation : null;
}

function LocalDevice({ appRuntime, daemonRuntime, name, attachedId, operation, interrupted, onAskAgent }: {
  appRuntime: WorkbenchAppRuntimeStore | null;
  daemonRuntime: WorkbenchDaemonRuntimeStore | null;
  name: string;
  attachedId: DaemonId | null;
  operation: WorkbenchReloadOperation;
  interrupted: boolean;
  onAskAgent: AskAgent;
}) {
  const appDirt = useSyncExternalStore(appRuntime?.subscribe ?? NO_SUBSCRIPTION,
    () => appRuntime?.getSnapshot() ?? null, () => appRuntime?.getSnapshot() ?? null);
  const { dirt: daemonDirt, update } = useDaemonFacts(daemonRuntime);
  const awaitRefresh = useRefreshAfterUpdate(appRuntime, operation);
  const [issueError, setIssueError] = useState("");
  const dirt = mergeReloadDirt(appDirt, daemonDirt);
  const plan = planReloadDevice({ local: true, dirt, update, appUpdateScopes: appDirt?.updateScopes ?? null });
  const mine = deviceOperation(operation, attachedId, attachedId);
  const ports: WorkbenchReloadDevicePorts = {
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
  const resolve = () => {
    if (!update?.projectId) return;
    setIssueError("");
    if (update.failure) {
      onAskAgent(update.projectId, [{ kind: "updateIssue", text: updateFailurePrompt(update, update.failure) }]);
      // The repair breadcrumb has done its job once an agent has the log.
      void daemonRuntime?.dismissUpdateFailure().catch((error: unknown) => {
        setIssueError(error instanceof Error ? error.message : "Unable to clear the failed update record.");
      });
    } else {
      onAskAgent(update.projectId, [{ kind: "updateIssue", text: updateConflictPrompt(update) }]);
    }
  };
  return (
    <WorkbenchReloadDevice
      disabled={running(operation) || interrupted}
      error={issueError || (mine?.phase === "failed" ? mine.error : null) || dirt?.error || null}
      local
      name={name}
      onResolve={update?.projectId ? resolve : null}
      pendingScopes={dirt?.pendingScopes ?? []}
      plan={plan}
      ports={ports}
      running={mine && running(mine) ? interrupted ? "Reconnecting" : OPERATION_LABELS[mine.phase] ?? "Updating" : null}
      startOpen
      unavailable={null}
    />
  );
}

function RemoteDevice({ source, appRuntime, attachedId, operation, interrupted }: {
  source: WorkspaceDaemonFact;
  appRuntime: WorkbenchAppRuntimeStore | null;
  attachedId: DaemonId | null;
  operation: WorkbenchReloadOperation;
  interrupted: boolean;
}) {
  const workspace = useWorkbenchClientController().mounted?.workspace ?? null;
  const daemonId = source.daemonId;
  const runtime = useMemo(() => workspace ? new WorkbenchDaemonRuntimeClient({ workspace, daemonId }) : null,
    [daemonId, workspace]);
  useEffect(() => {
    if (!runtime) return;
    void runtime.open();
    return () => runtime.dispose();
  }, [runtime]);
  const { dirt, update } = useDaemonFacts(runtime);
  const plan = planReloadDevice({ local: false, dirt, update });
  const mine = deviceOperation(operation, daemonId, attachedId);
  const ports: WorkbenchReloadDevicePorts = {
    reloadScope: scope => ignoringInterruption(async () => {
      if (!runtime) throw new Error("That device's reload controls are not ready.");
      await runtime.reloadScopes([scope.scope]);
    })(),
    reloadAll: async () => {
      if (!appRuntime) throw new Error("Workbench app reload controls are not ready.");
      await appRuntime.reloadAll({ daemonId });
    },
    pull: async reload => {
      if (!appRuntime) throw new Error("Workbench app update controls are not ready.");
      await appRuntime.pull({ reload, daemonId });
    },
  };
  const offline = source.connection === "current" ? null
    : source.connection === "sleeping" ? "asleep" : source.connection === "connecting" || source.connection === "reconnecting"
      ? "connecting" : "unavailable";
  return (
    <WorkbenchReloadDevice
      disabled={running(operation) || interrupted}
      error={(mine?.phase === "failed" ? mine.error : null) || dirt?.error || null}
      local={false}
      name={source.hostname}
      onResolve={null}
      pendingScopes={dirt?.pendingScopes ?? []}
      plan={plan}
      ports={ports}
      running={mine && running(mine) ? OPERATION_LABELS[mine.phase] ?? "Updating" : null}
      unavailable={offline}
    />
  );
}

export default function WorkbenchReloadPanel({ appRuntime, daemonRuntime, onAskAgent }: {
  appRuntime: WorkbenchAppRuntimeStore | null;
  daemonRuntime: WorkbenchDaemonRuntimeStore | null;
  onAskAgent: AskAgent;
}) {
  const client = useWorkbenchClientController();
  const mounted = client.mounted;
  const facts = mounted?.projectFacts ?? null;
  const sources = useSyncExternalStore(facts?.subscribe ?? NO_SUBSCRIPTION,
    () => facts?.getData()?.sources ?? null, () => facts?.getData()?.sources ?? null);
  const network = mounted?.networkClient ?? null;
  const networkState = useSyncExternalStore(network?.subscribe ?? NO_SUBSCRIPTION,
    () => network?.snapshot() ?? null, () => network?.snapshot() ?? null);
  const attached = networkState?.snapshot?.daemon?.daemonId;
  const attachedId = attached ? DaemonIdSchema.parse(attached) : null;
  const operation = useOperation(appRuntime);
  const interrupted = useWorkbenchAppConnectionInterrupted();
  const tabOutOfDate = useSyncExternalStore(appRuntime?.subscribe ?? NO_SUBSCRIPTION,
    () => appRuntime?.getSnapshot().tabOutOfDate ?? false, () => false);
  const local = sources?.find(source => source.daemonId === attachedId);
  const remotes = (sources ?? []).filter(source => source.daemonId !== attachedId && source.connection !== "revoked")
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
  const pullRunning = PULL_ACTIONS.has(operation.action) && running(operation);
  return (
    <div className="space-y-2" data-reload-panel="true">
      {tabOutOfDate && !pullRunning ? (
        <div className="flex items-center gap-2 pl-1 text-[0.8rem] text-fg/muted" data-tab-out-of-date="true">
          <span className="min-w-0 flex-1">This tab is out of date</span>
          <PrimaryButton className={SIDEBAR_BUTTON} onClick={() => window.location.reload()} shape="compact">Refresh</PrimaryButton>
        </div>
      ) : null}
      <div>
        <LocalDevice
          appRuntime={appRuntime}
          attachedId={attachedId}
          daemonRuntime={daemonRuntime}
          interrupted={interrupted}
          name={local?.hostname ?? "This device"}
          onAskAgent={onAskAgent}
          operation={operation}
        />
        {remotes.map(source => (
          <RemoteDevice
            appRuntime={appRuntime}
            attachedId={attachedId}
            interrupted={interrupted}
            key={source.daemonId}
            operation={operation}
            source={source}
          />
        ))}
      </div>
    </div>
  );
}
