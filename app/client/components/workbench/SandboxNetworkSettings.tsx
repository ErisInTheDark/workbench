"use client";

/*
 * - default SandboxNetworkSettings: render provider-declared global/project sandbox network controls.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkbenchSandboxNetworkSetting } from "workbench-shared/workbench/provider/provider-settings";
import { ResetIcon } from "./workbench-icons";
import { useWorkbenchDaemonClient } from "./WorkbenchWorkspaceContext";
import IconButton from "../ui/IconButton";
import { OptionCard } from "../ui/OptionCards";

export default function SandboxNetworkSettings ({
  projectId,
  scope,
}: {
  projectId: string | null;
  scope: "global" | "project";
}) {
  const daemon = useWorkbenchDaemonClient();
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<Array<WorkbenchSandboxNetworkSetting & { provider: string }>>([]);
  const requestGeneration = useRef(0);

  useEffect(() => {
    if (scope === "project" && !projectId) {
      setSettings([]);
      setIsLoading(false);
      return;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    let cancelled = false;
    setError("");
    setIsLoading(true);
    void daemon.sandboxNetwork.read(projectId ? { projectId } : {})
      .then(({ data }) => {
        if (!cancelled && requestGeneration.current === generation) setSettings(data);
      })
      .catch((readError: Error) => {
        if (!cancelled && requestGeneration.current === generation) {
          setSettings([]);
          setError(readError.message);
        }
      })
      .finally(() => {
        if (!cancelled && requestGeneration.current === generation) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, projectId, scope]);

  const update = useCallback((provider: string, enabled: boolean | null) => {
    if (scope === "global" && enabled === null) return;
    if (scope === "project" && !projectId) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setError("");
    setIsLoading(true);
    void daemon.sandboxNetwork.update(scope === "global"
      ? { enabled: enabled!, ...(projectId ? { projectId } : {}), provider, scope }
      : { enabled, projectId: projectId!, provider, scope })
      .then(({ data }) => {
        if (requestGeneration.current === generation) {
          setSettings(current => current.map(setting => data.find(updated => updated.provider === setting.provider) ?? setting));
        }
      })
      .catch((updateError: Error) => {
        if (requestGeneration.current === generation) setError(updateError.message);
      })
      .finally(() => {
        if (requestGeneration.current === generation) setIsLoading(false);
      });
  }, [daemon, projectId, scope]);

  return (
    <>
    {settings.map(setting => {
      const enabled = scope === "global" ? setting.globalEnabled : setting.effectiveEnabled;
      const hasProjectOverride = scope === "project" && setting.projectOverride !== null;
      return <div key={setting.provider} className="relative rounded-[0.85rem] py-1">
      <OptionCard
        className={hasProjectOverride ? "pr-12" : undefined}
        description={scope === "global"
          ? "Allow agents outbound network access."
          : "Allow agents outbound network access in this project."}
        disabled={isLoading}
        isChecked={enabled}
        isSingleChoice={false}
        label={setting.label}
        onClick={() => {
          update(setting.provider, !enabled);
        }}
      />
      {hasProjectOverride ? (
        <IconButton
          type="button"
          label={`Reset ${setting.label} to global`}
          display="hover-border"
          title={`Reset ${setting.label} to global`}
          className="absolute top-1/2 right-3 -translate-y-1/2 lg:-right-12"
          disabled={isLoading}
          onClick={() => {
            update(setting.provider, null);
          }}
        >
          <ResetIcon size={20} />
        </IconButton>
      ) : null}
      </div>;
    })}
      {error ? (
        <p className="m-0 text-[0.78rem] leading-5 text-danger">{error}</p>
      ) : null}
    </>
  );
}
