/*
 * Exports:
 * - default WorkbenchSettingsView: own settings presentation, persistence intents, and local capability lifecycle.
 */
"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

import type { WorkbenchLocalCapabilitySettings } from "workbench-shared/types";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import {
  createSettingsRoute,
  type WorkbenchSettingsScope,
} from "workbench-shared/workbench/navigation/workbench-route";
import {
  createDefaultProjectWorkbenchSettings,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  readGlobalWorkbenchSettings,
  readProjectWorkbenchSettings,
  WORKBENCH_SETTING_DEFINITIONS,
  writeGlobalWorkbenchSetting,
  writeProjectWorkbenchSetting,
  type WorkbenchGlobalSettings,
  type WorkbenchSettingKey,
} from "../../workbench/state/workbench-settings";
import { useWorkbenchProjectNavigation } from "../../workbench/navigation/use-workbench-project-navigation";
import SandboxNetworkSettings from "./SandboxNetworkSettings";
import WorkbenchNetworkSettings from "./WorkbenchNetworkSettings";
import VoiceSettings from "./voice/VoiceSettings";
import { ReloadIcon } from "./workbench-icons";
import WorkbenchIconButton from "./WorkbenchIconButton";
import WorkbenchOptionCards, { WorkbenchOptionCard } from "./WorkbenchOptionCards";
import WorkbenchReactDevelopmentModeSetting from "./WorkbenchReactDevelopmentModeSetting";
import WorkbenchStepSlider from "./WorkbenchStepSlider";
import {
  useWorkbenchClientStateController,
  useWorkbenchClientStateSnapshot,
} from "./workbench-client-state-context";
import { useWorkbenchDaemonClient } from "./WorkbenchDaemonClientContext";

const SETTINGS_ORDER: WorkbenchSettingKey[] = [
  "theme",
  "editorFontFamily",
  "editorSpellCheck",
  "composerSpellCheck",
  "fileOpenBehavior",
  "selectedProjectPinPlacement",
  "showUnopenableFiles",
  "threadCodeBlockWrap",
  "threadCodeDetails",
  "editorFontSize",
];
const DEFAULT_LOCAL_CAPABILITY_SETTINGS: WorkbenchLocalCapabilitySettings = {
  browseRawCommandsEnabled: false,
};
const EDITOR_FONT_SIZE_OPTIONS = [0.9, 1, 1.08, 1.18, 1.32, 1.48].map((value, index) => ({
  label: String(index + 1),
  value,
}));

function clampEditorFontSize(value: number) {
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, value));
}

export default function WorkbenchSettingsView({
  activeProjectId,
  onError,
  onNavigate,
  projectLabel,
  scope,
}: {
  activeProjectId: string;
  onError: (message: string) => void;
  onNavigate: (scope: WorkbenchSettingsScope) => void;
  projectLabel: string;
  scope: WorkbenchSettingsScope;
}) {
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const daemon = useWorkbenchDaemonClient();
  const projectHref = useWorkbenchProjectNavigation();
  const globalSettings = useMemo(
    () => readGlobalWorkbenchSettings(clientState.records),
    [clientState.records],
  );
  const projectSettings = useMemo(() => (
    activeProjectId
      ? readProjectWorkbenchSettings(
        clientState.daemonRegistrationId,
        activeProjectId,
        clientState.records,
      )
      : createDefaultProjectWorkbenchSettings()
  ), [activeProjectId, clientState.daemonRegistrationId, clientState.records]);
  const [localCapabilitySettings, setLocalCapabilitySettings] = useState<WorkbenchLocalCapabilitySettings>(
    DEFAULT_LOCAL_CAPABILITY_SETTINGS,
  );
  const [isLocalCapabilitySettingsLoading, setIsLocalCapabilitySettingsLoading] = useState(false);
  const [localCapabilitySettingsError, setLocalCapabilitySettingsError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setIsLocalCapabilitySettingsLoading(true);
    setLocalCapabilitySettingsError("");
    void daemon.localCapabilities.read()
      .then((payload) => {
        if (!cancelled) setLocalCapabilitySettings(payload.localCapabilities);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setLocalCapabilitySettings(DEFAULT_LOCAL_CAPABILITY_SETTINGS);
        setLocalCapabilitySettingsError(error.message);
      })
      .finally(() => {
        if (!cancelled) setIsLocalCapabilitySettingsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [daemon]);

  const updateBrowseRawCommandsEnabled = useCallback((enabled: boolean) => {
    const previousSettings = localCapabilitySettings;
    setLocalCapabilitySettings((current) => ({
      ...current,
      browseRawCommandsEnabled: enabled,
    }));
    setIsLocalCapabilitySettingsLoading(true);
    setLocalCapabilitySettingsError("");
    void daemon.localCapabilities.update({
      localCapabilities: {
        browseRawCommandsEnabled: enabled,
      },
    })
      .then((payload) => {
        setLocalCapabilitySettings(payload.localCapabilities);
      })
      .catch((error: Error) => {
        setLocalCapabilitySettings(previousSettings);
        setLocalCapabilitySettingsError(error.message);
      })
      .finally(() => {
        setIsLocalCapabilitySettingsLoading(false);
      });
  }, [daemon, localCapabilitySettings]);

  const updateGlobalSetting = useCallback(<K extends WorkbenchSettingKey>(
    key: K,
    value: WorkbenchGlobalSettings[K],
  ) => {
    const nextValue = (key === "editorFontSize" && typeof value === "number"
      ? clampEditorFontSize(value)
      : value) as WorkbenchGlobalSettings[K];
    void writeGlobalWorkbenchSetting(clientStateController, key, nextValue)
      .catch((error: Error) => onError(error.message));
  }, [clientStateController, onError]);

  const updateProjectSetting = useCallback(<K extends WorkbenchSettingKey>(
    key: K,
    value: WorkbenchGlobalSettings[K],
  ) => {
    if (!activeProjectId) return;
    const nextValue = (key === "editorFontSize" && typeof value === "number"
      ? clampEditorFontSize(value)
      : value) as WorkbenchGlobalSettings[K];
    void writeProjectWorkbenchSetting(clientStateController, activeProjectId, key, {
      enabled: true,
      value: nextValue,
    }).catch((error: Error) => onError(error.message));
  }, [activeProjectId, clientStateController, onError]);

  const resetProjectSettingOverride = useCallback((key: WorkbenchSettingKey) => {
    if (!activeProjectId) return;
    void writeProjectWorkbenchSetting(clientStateController, activeProjectId, key, {
      ...projectSettings[key],
      enabled: false,
    }).catch((error: Error) => onError(error.message));
  }, [activeProjectId, clientStateController, onError, projectSettings]);

  const openScope = (event: MouseEvent<HTMLAnchorElement>, nextScope: WorkbenchSettingsScope) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;
    event.preventDefault();
    onNavigate(nextScope);
  };

  const renderSettingControl = (
    key: WorkbenchSettingKey,
    value: WorkbenchGlobalSettings[WorkbenchSettingKey],
    disabled: boolean,
    onChange: (nextValue: WorkbenchGlobalSettings[WorkbenchSettingKey]) => void,
  ) => {
    const definition = WORKBENCH_SETTING_DEFINITIONS[key];
    if (key === "editorFontSize") {
      return (
        <WorkbenchStepSlider
          ariaLabel={definition.label}
          disabled={disabled}
          steps={EDITOR_FONT_SIZE_OPTIONS}
          value={typeof value === "number" ? value : 1.08}
          onChange={onChange}
        />
      );
    }
    if (definition.type === "boolean" && typeof value === "boolean") {
      return (
        <WorkbenchOptionCard
          description={definition.description}
          isChecked={value}
          isSingleChoice={false}
          label={definition.label}
          onClick={() => onChange(!value)}
        />
      );
    }
    if (!definition.options) return null;
    return (
      <WorkbenchOptionCards<WorkbenchGlobalSettings[WorkbenchSettingKey]>
        ariaLabel={definition.label}
        columns={definition.columns ?? "one"}
        disabled={disabled}
        mode="radio"
        options={definition.options}
        value={value}
        onChange={(nextValue) => {
          if (!disabled) onChange(nextValue);
        }}
      />
    );
  };

  const renderGlobalSettingRow = (key: WorkbenchSettingKey) => {
    const definition = WORKBENCH_SETTING_DEFINITIONS[key];
    const unavailable = key === "threadCodeDetails" && clientState.schemaVersion < appStateReleases.threadCodeDetails.version;
    if (definition.type === "boolean") {
      return (
        <section key={key} className="rounded-[0.85rem] py-1">
          {renderSettingControl(key, globalSettings[key], unavailable, (nextValue) => {
            updateGlobalSetting(key, nextValue as never);
          })}
          {unavailable ? <p>Available after the app database is reloaded.</p> : null}
        </section>
      );
    }
    return (
      <section key={key} className="space-y-3 rounded-[0.85rem] py-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 text-[0.98rem] font-semibold leading-tight text-text">{definition.label}</h3>
            <p className="mt-1 mb-0 text-[0.82rem] leading-6 text-fg/muted">{definition.description}</p>
          </div>
        </div>
        {renderSettingControl(key, globalSettings[key], false, (nextValue) => {
          updateGlobalSetting(key, nextValue as never);
        })}
      </section>
    );
  };

  const renderProjectSettingRow = (key: WorkbenchSettingKey) => {
    const definition = WORKBENCH_SETTING_DEFINITIONS[key];
    const unavailable = key === "threadCodeDetails" && clientState.schemaVersion < appStateReleases.threadCodeDetails.version;
    const override = projectSettings[key];
    const inheritedValue = globalSettings[key];
    const displayedValue = override.enabled ? override.value : inheritedValue;
    if (definition.type === "boolean" && typeof displayedValue === "boolean") {
      return (
        <section key={key} className="relative rounded-[0.85rem] py-1">
          <WorkbenchOptionCard
            className={override.enabled ? "pr-12" : undefined}
            description={definition.description}
            disabled={unavailable}
            isChecked={displayedValue}
            isSingleChoice={false}
            label={definition.label}
            onClick={() => updateProjectSetting(key, !displayedValue as never)}
          />
          {override.enabled ? (
            <WorkbenchIconButton
              type="button"
              label={`Reset ${definition.label} to global`}
              display="hover-border"
              title={`Reset ${definition.label} to global`}
              className="absolute top-1/2 right-3 -translate-y-1/2"
              onClick={() => resetProjectSettingOverride(key)}
              disabled={unavailable}
            >
              <ReloadIcon size={20} />
            </WorkbenchIconButton>
          ) : null}
          {unavailable ? <p>Available after the app database is reloaded.</p> : null}
        </section>
      );
    }
    return (
      <section key={key} className="space-y-3 rounded-[0.85rem] py-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 text-[0.98rem] font-semibold leading-tight text-text">{definition.label}</h3>
            <p className="mt-1 mb-0 text-[0.82rem] leading-6 text-fg/muted">{definition.description}</p>
          </div>
          {override.enabled ? (
            <WorkbenchIconButton
              type="button"
              label={`Reset ${definition.label} to global`}
              display="hover-border"
              title={`Reset ${definition.label} to global`}
              onClick={() => resetProjectSettingOverride(key)}
            >
              <ReloadIcon size={20} />
            </WorkbenchIconButton>
          ) : null}
        </div>
        {renderSettingControl(key, displayedValue, false, (nextValue) => {
          updateProjectSetting(key, nextValue as never);
        })}
      </section>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-8 py-8">
      <section className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-fg/muted uppercase">Preferences</p>
            <h1 className="m-0 text-[1.65rem] font-semibold leading-tight text-text">Settings</h1>
          </div>
          <div className="flex min-w-0 items-end gap-4" role="tablist" aria-label="Settings scope">
            <a
              href={projectHref(createSettingsRoute(activeProjectId, "global"))}
              role="tab"
              aria-selected={scope === "global"}
              className={`border-b-2 px-0 pb-1 text-[0.9rem] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${scope === "global"
                ? " border-text text-text"
                : " border-transparent text-fg/muted hover:text-text"}`}
              onClick={(event) => openScope(event, "global")}
            >
              Global
            </a>
            <a
              href={projectHref(createSettingsRoute(activeProjectId, "project"))}
              role="tab"
              aria-selected={scope === "project"}
              className={`min-w-0 border-b-2 px-0 pb-1 text-[0.9rem] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${scope === "project"
                ? " border-text text-text"
                : " border-transparent text-fg/muted hover:text-text"}`}
              onClick={(event) => openScope(event, "project")}
            >
              <span className="block max-w-[12rem] truncate">{projectLabel}</span>
            </a>
          </div>
        </div>

        <div className="space-y-7" role="tabpanel">
          {scope === "global"
            ? (
              <>
                {SETTINGS_ORDER.map(renderGlobalSettingRow)}
                <WorkbenchNetworkSettings />
                <VoiceSettings />
                <WorkbenchReactDevelopmentModeSetting />
                <section className="space-y-3 rounded-[0.85rem] py-1">
                  <div className="min-w-0">
                    <h3 className="m-0 text-[0.98rem] font-semibold leading-tight text-text">Local command capabilities</h3>
                  </div>
                  <SandboxNetworkSettings key={`global:${activeProjectId}`} projectId={activeProjectId} scope="global" />
                  <WorkbenchOptionCard
                    description="Allow raw Browse CLI usage outside the sandbox."
                    disabled={isLocalCapabilitySettingsLoading}
                    isChecked={localCapabilitySettings.browseRawCommandsEnabled}
                    isSingleChoice={false}
                    label="Raw Browse commands"
                    onClick={() => updateBrowseRawCommandsEnabled(!localCapabilitySettings.browseRawCommandsEnabled)}
                  />
                  {localCapabilitySettingsError ? (
                    <p className="m-0 text-[0.78rem] leading-5 text-danger">{localCapabilitySettingsError}</p>
                  ) : null}
                </section>
              </>
            )
            : (
              <>
                {SETTINGS_ORDER.map(renderProjectSettingRow)}
                <SandboxNetworkSettings key={`project:${activeProjectId}`} projectId={activeProjectId} scope="project" />
              </>
            )}
        </div>
      </section>
    </div>
  );
}
