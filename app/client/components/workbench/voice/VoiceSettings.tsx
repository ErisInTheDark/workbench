/* Exports:
 * - VoiceInputSetting: app preference that turns voice input on or off.
 * - default VoiceSettings: the voice daemon's model drag menu, readiness and audio retention.
 */
import { useContext, useEffect, useSyncExternalStore } from "react";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { matchesWorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import type VoiceSettingsController from "../../../workbench/voice/VoiceSettingsController";
import WorkbenchClientContext from "../workbench-client-context";
import LoaderIcon from "../LoaderIcon";
import { OptionCard } from "../../ui/OptionCards";
import SettingsCard, { SettingsCardRow } from "../../ui/SettingsCard";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import WorkbenchModelMenu from "../WorkbenchModelMenu";
import { CheckIcon, ChevronDownIcon, HarnessIcon } from "../workbench-icons";

function useVoiceSettings() {
  return useContext(WorkbenchClientContext)?.mounted?.voice?.settings ?? null;
}

function useSnapshot(controller: VoiceSettingsController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export function VoiceInputSetting() {
  const controller = useVoiceSettings();
  return controller ? <VoiceInputToggle controller={controller} /> : null;
}

function VoiceInputToggle({ controller }: { controller: VoiceSettingsController }) {
  const state = useSnapshot(controller);
  return <div className="py-1">
    <OptionCard label="Voice input" description="Dictate into editors and composers."
      isChecked={state.inputEnabled} isSingleChoice={false} disabled={!state.canToggle}
      onClick={() => { void controller.setEnabled(!state.inputEnabled); }} />
    {!state.canToggle ? <p className="m-0 px-3 pt-1 text-xs text-fg/muted">Reload the app database to save voice preferences.</p> : null}
  </div>;
}

export default function VoiceSettings() {
  const controller = useVoiceSettings();
  return controller ? <VoiceModel controller={controller} /> : null;
}

function VoiceModel({ controller }: { controller: VoiceSettingsController }) {
  const state = useSnapshot(controller);
  useEffect(() => { void controller.loadModels(); }, [controller]);
  const selection = state.selection;
  const model = selection
    ? state.catalogues[selection.harness]?.find(option => matchesWorkbenchModelOption(option, selection.model))
    : undefined;
  const pending = state.status === "loading" || state.status === "saving" || state.status === "preparing";
  return <SettingsCard label="Voice">
    <SettingsCardRow label="Model">
      <WorkbenchModelMenu
        label="Voice model"
        catalogues={state.catalogues}
        allowedHarnesses={installedProviderKeys}
        selected={selection ? { harness: selection.harness, modelId: selection.model } : null}
        onSelect={entry => { void controller.selectModel(entry.harness, entry.model.id); }}
      >
        {selection ? <HarnessIcon harness={selection.harness} size={16} className="shrink-0" /> : null}
        <span className={`max-w-64 truncate ${selection ? "" : "text-fg/muted"}`}>
          {model?.displayName ?? selection?.model ?? (state.cataloguesLoading ? "Loading models..." : "Choose model")}
        </span>
        <ChevronDownIcon size={14} className="shrink-0 text-fg/muted" />
      </WorkbenchModelMenu>
      <span role="status" aria-label={`Voice ${state.status}`} title={state.status}
        className="inline-flex size-4 items-center justify-center text-fg/muted">
        {pending ? <LoaderIcon size={12} /> : state.status === "ready" ? <CheckIcon size={14} className="text-success" /> : null}
      </span>
      <span className="ml-auto text-base">
        <WorkbenchCheckbox label="Save audio locally" checked={state.recordAudio} disabled={!selection}
          onChange={value => { void controller.setRecordAudio(value); }} />
      </span>
    </SettingsCardRow>
    {state.error ? <SettingsCardRow><p role="alert" className="m-0 text-danger">{state.error}</p></SettingsCardRow> : null}
  </SettingsCard>;
}
