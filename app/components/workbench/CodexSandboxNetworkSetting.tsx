"use client";

/*
 * default CodexSandboxNetworkSetting: render and mutate server-owned global or project Codex sandbox network settings. Keywords: Codex, sandbox, network, settings.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkbenchCodexSandboxNetworkSettings } from "workbench-shared/types";
import { workbenchIconButtonClassName } from "./workbench-class-names";
import { ReloadIcon } from "./workbench-icons";
import { useWorkbenchDaemonClient } from "./WorkbenchDaemonClientContext";
import { WorkbenchOptionCard } from "./WorkbenchOptionCards";

const DEFAULT_SETTINGS: WorkbenchCodexSandboxNetworkSettings = {
  effectiveEnabled: false,
  globalEnabled: false,
  projectId: "",
  projectOverride: null,
};

export default function CodexSandboxNetworkSetting ({
  projectId,
  scope,
}: {
  projectId: string;
  scope: "global" | "project";
}) {
  const daemon = useWorkbenchDaemonClient();
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    let cancelled = false;
    setError("");
    setIsLoading(true);
    void daemon.request("codex-sandbox-network/read", { projectId })
      .then(({ codexSandboxNetwork }) => {
        if (!cancelled && requestGeneration.current === generation) setSettings(codexSandboxNetwork);
      })
      .catch((readError: Error) => {
        if (!cancelled && requestGeneration.current === generation) {
          setSettings({ ...DEFAULT_SETTINGS, projectId });
          setError(readError.message);
        }
      })
      .finally(() => {
        if (!cancelled && requestGeneration.current === generation) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, projectId]);

  const update = useCallback((enabled: boolean | null) => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setError("");
    setIsLoading(true);
    void daemon.request("codex-sandbox-network/update", {
      enabled,
      projectId,
      scope,
    })
      .then(({ codexSandboxNetwork }) => {
        if (requestGeneration.current === generation) setSettings(codexSandboxNetwork);
      })
      .catch((updateError: Error) => {
        if (requestGeneration.current === generation) setError(updateError.message);
      })
      .finally(() => {
        if (requestGeneration.current === generation) setIsLoading(false);
      });
  }, [daemon, projectId, scope]);

  const enabled = scope === "global" ? settings.globalEnabled : settings.effectiveEnabled;
  const hasProjectOverride = scope === "project" && settings.projectOverride !== null;
  return (
    <div className="relative rounded-[0.85rem] py-1">
      <WorkbenchOptionCard
        className={hasProjectOverride ? "pr-12" : undefined}
        description={scope === "global"
          ? "Allow agents outbound network access."
          : "Allow agents outbound network access in this project."}
        disabled={isLoading}
        isChecked={enabled}
        isSingleChoice={false}
        label="Codex sandbox network access"
        onClick={() => {
          update(!enabled);
        }}
      />
      {hasProjectOverride ? (
        <button
          type="button"
          aria-label="Reset Codex sandbox network access to global"
          title="Reset Codex sandbox network access to global"
          className={`${workbenchIconButtonClassName} absolute top-1/2 right-3 -translate-y-1/2`}
          disabled={isLoading}
          onClick={() => {
            update(null);
          }}
        >
          <ReloadIcon />
        </button>
      ) : null}
      {error ? (
        <p className="m-0 text-[0.78rem] leading-5 text-danger">{error}</p>
      ) : null}
    </div>
  );
}
