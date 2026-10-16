/*
 * Exports:
 * - default WorkbenchBrowseCapabilitySetting: toggle one daemon's raw Browse CLI capability.
 */
"use client";

import { useEffect, useState } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { OptionCard } from "../ui/OptionCards";

export default function WorkbenchBrowseCapabilitySetting({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void daemon.localCapabilities.read().then(payload => {
      if (!cancelled) setEnabled(payload.localCapabilities.browseRawCommandsEnabled);
    }).catch((failure: Error) => {
      if (!cancelled) setError(failure.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [daemon]);
  function toggle() {
    if (loading) return;
    setLoading(true);
    setError("");
    void daemon.localCapabilities.update({ localCapabilities: { browseRawCommandsEnabled: !enabled } })
      .then(payload => setEnabled(payload.localCapabilities.browseRawCommandsEnabled))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setLoading(false));
  }
  return <div className="py-1">
    <OptionCard label="Raw Browse commands" description="Allow raw Browse CLI usage outside the sandbox."
      isSingleChoice={false} isChecked={enabled} disabled={loading} onClick={toggle} />
    {error ? <p role="alert" className="m-0 px-3 pt-1 text-xs text-danger">{error}</p> : null}
  </div>;
}
