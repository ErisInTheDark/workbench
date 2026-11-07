/*
 * Exports:
 * - default WorkbenchWindowsSandboxSettings: show whether the selected Windows daemon's agent shells get Codex's elevated sandbox,
 *   and set it up there.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { WindowsSandboxStatus } from "workbench-shared/workbench/provider/windows-sandbox";
import IconButton from "../ui/IconButton";
import PrimaryButton from "../ui/PrimaryButton";
import { RefreshCwIcon } from "./workbench-icons";
import WorkbenchSettingsStatusRow, { type WorkbenchSettingsStatusTone } from "./WorkbenchSettingsStatusRow";

const BASIC_DETAIL = "Sandboxed commands run as you, and blocked network access is only advisory.";

type WindowsSandboxRowStatus = Exclude<WindowsSandboxStatus, { state: "unsupported" }>;

function present(status: WindowsSandboxRowStatus | null): { tone: WorkbenchSettingsStatusTone; status: string; detail: string; action: string | null } {
  switch (status?.state) {
    case undefined:
      return { tone: "pending", status: "Checking", detail: "Checking this daemon's Windows sandbox...", action: null };
    case "ready":
      return {
        tone: "ready", status: "Elevated",
        detail: "Sandboxed commands run as separate Windows accounts, and the firewall enforces blocked network access.", action: null,
      };
    case "not-set-up":
      return {
        tone: "action", status: "Basic",
        detail: `${BASIC_DETAIL} Setting up the elevated sandbox once needs administrator approval on this daemon's machine.`, action: "Set up",
      };
    case "update-required":
      return {
        tone: "action", status: "Needs update",
        detail: `Codex changed its elevated sandbox, so it needs updating. Until then: ${BASIC_DETAIL}`, action: "Update",
      };
    case "setting-up":
      return { tone: "pending", status: "Setting up", detail: "Approve the administrator prompt on this daemon's machine...", action: null };
    case "failed":
      return { tone: "failed", status: "Setup failed", detail: BASIC_DETAIL, action: "Retry" };
  }
}

export default function WorkbenchWindowsSandboxSettings({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const [status, setStatus] = useState<WindowsSandboxStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  /** Newer reads and settled setups invalidate older in-flight reads. */
  const generation = useRef(0);
  /** The setting-up status this row already waits on; a fresh one from a read means a setup started elsewhere. */
  const joined = useRef<WindowsSandboxStatus | null>(null);

  const check = useCallback(() => {
    const current = ++generation.current;
    setChecking(true);
    setError("");
    void daemon.windowsSandbox.read().then(next => {
      if (current === generation.current) setStatus(next);
    }).catch((failure: unknown) => {
      if (current === generation.current) setError((failure instanceof Error ? failure.message : "Sandbox check failed.").slice(0, 500));
    }).finally(() => {
      if (current === generation.current) setChecking(false);
    });
  }, [daemon]);

  /** Starts or joins the daemon-owned setup; it keeps going if this view closes. */
  const setUp = useCallback(() => {
    const current = ++generation.current;
    const pending: WindowsSandboxStatus = { state: "setting-up" };
    joined.current = pending;
    setStatus(pending);
    setError("");
    void daemon.windowsSandbox.setUp().then(next => {
      if (current === generation.current) setStatus(next);
    }).catch(() => {
      // A dropped socket or a Codex reload doesn't settle the setup; reread its real state instead of reporting failure.
      if (current === generation.current) check();
    });
  }, [check, daemon]);

  useEffect(() => {
    check();
    return () => { generation.current++; };
  }, [check]);

  useEffect(() => {
    if (status?.state === "setting-up" && joined.current !== status) setUp();
  }, [setUp, status]);

  if (status?.state === "unsupported") return null;
  const view = present(status);
  const failure = status?.state === "failed" ? status.error : error;
  return <WorkbenchSettingsStatusRow label="Windows sandbox" tone={view.tone} status={view.status} detail={view.detail} error={failure}>
    {view.action ? <PrimaryButton shape="compact" onClick={setUp}>{view.action}</PrimaryButton> : null}
    <IconButton display="hover-border" size="small"
      label={checking ? "Checking the Windows sandbox" : "Recheck the Windows sandbox"}
      disabled={checking || status?.state === "setting-up"} aria-busy={checking} onClick={check}>
      <RefreshCwIcon className={`size-4 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} />
    </IconButton>
  </WorkbenchSettingsStatusRow>;
}
