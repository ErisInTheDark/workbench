/*
 * Default export:
 * - WorkbenchRepoPrerequisiteSettings: show the selected daemon's virtual repository prerequisites with install guidance and recheck.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { VirtualRepoAvailability } from "workbench-shared/workbench/repo/virtual-repo-contract";
import { ExternalLinkIcon, RefreshCwIcon } from "./workbench-icons";
import WorkbenchIconButton from "./WorkbenchIconButton";
import WorkbenchLinkButton from "./WorkbenchLinkButton";

const WINFSP_DOWNLOAD_URL = "https://winfsp.dev/rel/";

type Tone = "ready" | "action" | "failed" | "pending";

function present (availability: VirtualRepoAvailability): { tone: Tone; status: string; detail: string } {
  switch (availability.status) {
    case "available":
      return { tone: "ready", status: "Ready", detail: "Agents can use wb git repo to read remote repositories as read-only folders." };
    case "missing":
      if (availability.requirement === "winfsp") {
        return { tone: "action", status: "Needs WinFsp", detail: "Install WinFsp on this daemon's machine (only the default Core component is required)." };
      }
      if (availability.requirement === "fuse") {
        return { tone: "action", status: "Needs FUSE", detail: "Install fuse3 with your package manager, then recheck." };
      }
      return { tone: "action", status: "Needs Git", detail: "Git 2.44 or newer must be on this daemon's PATH." };
    case "nativeMissing":
      return { tone: "failed", status: "Sidecar missing", detail: "Run pnpm build:repo in the Workbench repository." };
    case "unsupported":
      return { tone: "failed", status: "Unsupported", detail: "Virtual repositories need Windows or Linux on x64." };
    case "checkFailed":
      return { tone: "failed", status: "Check failed", detail: "Prerequisites could not be checked. Recheck, or see the daemon log." };
  }
}

const toneClassName: Record<Tone, string> = {
  ready: "text-success",
  action: "text-[color:var(--attention)]",
  failed: "text-danger",
  pending: "text-fg/muted",
};

export default function WorkbenchRepoPrerequisiteSettings ({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const [availability, setAvailability] = useState<VirtualRepoAvailability | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);

  const check = useCallback(() => {
    const current = ++generation.current;
    setChecking(true);
    setError("");
    void daemon.virtualRepos.availability().then(next => {
      if (current === generation.current) setAvailability(next);
    }).catch((failure: unknown) => {
      if (current === generation.current) setError((failure instanceof Error ? failure.message : "Availability check failed.").slice(0, 500));
    }).finally(() => {
      if (current === generation.current) setChecking(false);
    });
  }, [daemon]);

  useEffect(() => {
    check();
    // Invalidate responses that arrive after this daemon's row unmounts.
    return () => { generation.current++; };
  }, [check]);

  const view = availability ? present(availability)
    : { tone: "pending" as const, status: "Checking", detail: "Checking this daemon's prerequisites..." };
  const showWinFsp = availability?.status === "missing" && availability.requirement === "winfsp";
  return <div className="py-1">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[0.95rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-2.5">
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[0.86em] font-medium leading-[1.5] text-text">Virtual repositories</span>
          <span role="status" className={`inline-flex items-center gap-1.5 text-[0.76em] leading-[1.5] ${toneClassName[view.tone]}`}>
            <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${view.tone === "pending" ? "motion-safe:animate-pulse" : ""}`} />
            {view.status}
          </span>
        </div>
        <p className="m-0 mt-0.5 text-[0.78em] leading-[1.55] text-fg/muted">{view.detail}</p>
        {error ? <p role="alert" className="m-0 mt-0.5 text-[0.78em] leading-[1.55] text-danger">{error}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {showWinFsp ? <WorkbenchLinkButton href={WINFSP_DOWNLOAD_URL} target="_blank" rel="noreferrer">
          Download WinFsp<ExternalLinkIcon aria-hidden="true" className="size-4" />
        </WorkbenchLinkButton> : null}
        <WorkbenchIconButton display="hover-border" size="small"
          label={checking ? "Checking prerequisites" : "Recheck prerequisites"}
          disabled={checking} aria-busy={checking} onClick={check}>
          <RefreshCwIcon className={`size-4 ${checking ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </WorkbenchIconButton>
      </div>
    </div>
  </div>;
}
