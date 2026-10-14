/*
 * Exports:
 * - default WorkbenchProviderRuntimeSettings: show and install the selected daemon's Workbench-managed Claude Code and OpenCode runtimes.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type {
  ProviderRuntimeKey,
  ProviderRuntimeStatus,
  ProviderRuntimesSnapshot,
} from "workbench-shared/workbench/provider/provider-runtime";
import IconButton from "../ui/IconButton";
import PrimaryButton from "../ui/PrimaryButton";
import { RefreshCwIcon } from "./workbench-icons";
import WorkbenchSettingsStatusRow, { type WorkbenchSettingsStatusTone } from "./WorkbenchSettingsStatusRow";

const labels: Record<ProviderRuntimeKey, string> = { claude: "Claude Code", opencode: "OpenCode" };

function failureMessage(failure: unknown, fallback: string) {
  return (failure instanceof Error ? failure.message : fallback).slice(0, 500);
}

function present(status: ProviderRuntimeStatus, installing: boolean): {
  tone: WorkbenchSettingsStatusTone; status: string; detail: string; action: string | null;
} {
  const label = labels[status.provider];
  if (installing || status.state === "installing") {
    return { tone: "pending", status: "Installing", detail: `Downloading ${label} ${status.version} onto this daemon...`, action: null };
  }
  switch (status.state) {
    case "ready":
      return { tone: "ready", status: `Ready · ${status.version}`, detail: `Threads use Workbench's pinned ${label} build.`, action: null };
    case "missing":
      return status.installedVersion
        ? { tone: "action", status: "Update needed", detail: `${status.installedVersion} is installed; this Workbench needs ${status.version}.`, action: "Update" }
        : { tone: "action", status: "Not installed", detail: `Install ${label} ${status.version} to use it in threads on this daemon.`, action: "Install" };
    case "failed":
      return { tone: "failed", status: "Install failed", detail: status.error ?? "The install failed. See the daemon log.", action: "Retry" };
    case "unsupported":
      return { tone: "failed", status: "Unsupported", detail: status.error ?? `${label} has no build for this daemon's platform.`, action: null };
  }
}

export default function WorkbenchProviderRuntimeSettings({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const [snapshot, setSnapshot] = useState<ProviderRuntimesSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState<ReadonlySet<ProviderRuntimeKey>>(() => new Set());
  const [error, setError] = useState("");
  /** Newer reads and settled installs invalidate older in-flight reads. */
  const generation = useRef(0);
  const mounted = useRef(true);

  const check = useCallback(() => {
    const current = ++generation.current;
    setChecking(true);
    setError("");
    void daemon.providerRuntimes.read().then(next => {
      if (current === generation.current) setSnapshot(next);
    }).catch((failure: unknown) => {
      if (current === generation.current) setError(failureMessage(failure, "Runtime check failed."));
    }).finally(() => {
      if (current === generation.current) setChecking(false);
    });
  }, [daemon]);

  const settle = useCallback((provider: ProviderRuntimeKey) => {
    setInstalling(current => {
      const next = new Set(current);
      next.delete(provider);
      return next;
    });
  }, []);

  /** Starts or joins the daemon-owned install; the daemon keeps going if this view closes. */
  const install = useCallback((provider: ProviderRuntimeKey) => {
    setInstalling(current => new Set(current).add(provider));
    setError("");
    void daemon.providerRuntimes.install(provider).then(next => {
      if (!mounted.current) return;
      generation.current++;
      setSnapshot(next);
      setChecking(false);
      settle(provider);
    }).catch(() => {
      // A dropped socket doesn't stop the daemon's install; reread its real state instead of reporting failure.
      if (!mounted.current) return;
      settle(provider);
      check();
    });
  }, [check, daemon, settle]);

  useEffect(() => {
    mounted.current = true;
    check();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [check]);

  // Follow installs started elsewhere (another tab, or the daemon updating a stale runtime) until they settle.
  // Keyed to each new snapshot, so a failed join never re-joins until a fresh read confirms the install.
  const followed = useRef<ProviderRuntimesSnapshot | null>(null);
  useEffect(() => {
    if (!snapshot || followed.current === snapshot) return;
    followed.current = snapshot;
    for (const status of snapshot.data) {
      if (status.state === "installing" && !installing.has(status.provider)) install(status.provider);
    }
  }, [install, installing, snapshot]);

  if (!snapshot) {
    return <WorkbenchSettingsStatusRow label="Providers" tone={error ? "failed" : "pending"}
      status={error ? "Check failed" : "Checking"} detail="Checking this daemon's provider runtimes..." error={error}>
      <IconButton display="hover-border" size="small" label="Recheck provider runtimes"
        disabled={checking} aria-busy={checking} onClick={check}>
        <RefreshCwIcon className={`size-4 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} />
      </IconButton>
    </WorkbenchSettingsStatusRow>;
  }
  return <>
    {snapshot.data.map(status => {
      const view = present(status, installing.has(status.provider));
      return <WorkbenchSettingsStatusRow key={status.provider} label={labels[status.provider]}
        tone={view.tone} status={view.status} detail={view.detail}>
        {view.action ? <PrimaryButton shape="compact" onClick={() => install(status.provider)}>{view.action}</PrimaryButton> : null}
        <IconButton display="hover-border" size="small"
          label={checking ? `Checking ${labels[status.provider]}` : `Recheck ${labels[status.provider]}`}
          disabled={checking} aria-busy={checking} onClick={check}>
          <RefreshCwIcon className={`size-4 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </IconButton>
      </WorkbenchSettingsStatusRow>;
    })}
    {error ? <p role="alert" className="m-0 px-3 text-[0.78em] leading-[1.55] text-danger">{error}</p> : null}
  </>;
}
