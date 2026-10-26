/*
 * Default export:
 * - WorkbenchInstallationSettings: show whether the selected daemon's data root records its running checkout as the installation, and repair it.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { InstallationRecordStatus } from "workbench-shared/workbench/installation-record";
import IconButton from "../ui/IconButton";
import PrimaryButton from "../ui/PrimaryButton";
import { RefreshCwIcon } from "./workbench-icons";
import WorkbenchSettingsStatusRow, { type WorkbenchSettingsStatusTone } from "./WorkbenchSettingsStatusRow";

const UNFOUND = "wb packages in other projects can't find this checkout.";

function present ({ checkoutRoot, record }: InstallationRecordStatus): { tone: WorkbenchSettingsStatusTone; status: string; detail: string; action: string | null } {
  switch (record.state) {
    case "current":
      return { tone: "ready", status: "Recorded", detail: `wb packages in other projects use ${checkoutRoot}.`, action: null };
    case "missing":
      return { tone: "action", status: "Not recorded", detail: UNFOUND, action: "Record this checkout" };
    case "elsewhere":
      return {
        tone: "action", status: "Elsewhere",
        detail: `${record.phase === "ready" ? "Recorded" : `Unfinished (${record.phase}) install`} at ${record.root}.\n${UNFOUND}`,
        action: "Use this checkout",
      };
    case "invalid":
      return { tone: "failed", status: "Invalid", detail: `${record.message}\n${UNFOUND}`, action: "Replace with this checkout" };
  }
}

export default function WorkbenchInstallationSettings ({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const [status, setStatus] = useState<InstallationRecordStatus | null>(null);
  const [busy, setBusy] = useState<"checking" | "recording" | null>("checking");
  const [error, setError] = useState("");
  const generation = useRef(0);

  const run = useCallback((kind: "checking" | "recording", request: () => Promise<InstallationRecordStatus>) => {
    const current = ++generation.current;
    setBusy(kind);
    setError("");
    void request().then(next => {
      if (current === generation.current) setStatus(next);
    }).catch((failure: unknown) => {
      if (current === generation.current) setError((failure instanceof Error ? failure.message : "Installation record request failed.").slice(0, 500));
    }).finally(() => {
      if (current === generation.current) setBusy(null);
    });
  }, []);
  const check = useCallback(() => run("checking", () => daemon.installationRecord.read()), [daemon, run]);

  useEffect(() => {
    check();
    // Invalidate responses that arrive after this daemon's row unmounts.
    return () => { generation.current++; };
  }, [check]);

  const view = status ? present(status)
    : { tone: "pending" as const, status: "Checking", detail: "Checking this daemon's installation record...", action: null };
  return <WorkbenchSettingsStatusRow label="Installation" tone={view.tone} status={view.status} detail={view.detail} error={error}>
    {view.action ? <PrimaryButton shape="compact" disabled={busy !== null} pendingHalo={busy === "recording"}
      onClick={() => run("recording", () => daemon.installationRecord.adopt())}>
      {view.action}
    </PrimaryButton> : null}
    <IconButton display="hover-border" size="small"
      label={busy === "checking" ? "Checking installation record" : "Recheck installation record"}
      disabled={busy !== null} aria-busy={busy === "checking"} onClick={check}>
      <RefreshCwIcon className={`size-4 ${busy === "checking" ? "animate-spin motion-reduce:animate-none" : ""}`} />
    </IconButton>
  </WorkbenchSettingsStatusRow>;
}
