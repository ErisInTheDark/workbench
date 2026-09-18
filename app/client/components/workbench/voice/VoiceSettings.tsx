/* Exports:
 * - default VoiceSettings: independent harness/model drag selectors for voice input.
 */
import { useContext, useEffect, useSyncExternalStore } from "react";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type VoiceSettingsController from "../../../workbench/voice/VoiceSettingsController";
import WorkbenchClientContext from "../workbench-client-context";
import WorkbenchPressDragMenu from "../WorkbenchPressDragMenu";
import ThreadHarnessControl from "../thread-view/ThreadHarnessControl";
import LoaderIcon from "../LoaderIcon";
import { WorkbenchOptionCard } from "../WorkbenchOptionCards";
import { CheckIcon, XIcon } from "../workbench-icons";

export default function VoiceSettings() {
  const client = useContext(WorkbenchClientContext)?.mounted?.voice;
  return client ? <VoiceSelectors controller={client.settings} /> : null;
}

function VoiceSelectors({ controller }: { controller: VoiceSettingsController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    if (state.catalogue === "idle" && state.status !== "loading") void controller.loadModels();
  }, [controller, state.harness, state.catalogue, state.status]);
  const selectedModel = state.selection?.harness === state.harness ? state.selection.model : null;
  const models = state.catalogue === "ready" ? state.models.filter(model => !model.hidden) : [];
  const pending = ["loading", "saving", "preparing"].includes(state.status);

  return <section aria-label="Voice input" className="grid gap-2 rounded-[0.85rem] py-1">
    <WorkbenchOptionCard
      label="Voice input"
      isChecked={state.inputEnabled}
      isSingleChoice={false}
      disabled={!state.canToggle}
      onClick={() => { void controller.setEnabled(!state.inputEnabled); }}
    >
    <div className="flex flex-wrap items-center gap-2">
      <WorkbenchPressDragMenu
        label="Voice harness"
        items={installedProviderKeys.map(harness => ({
          id: harness, checked: state.harness === harness,
          content: <ThreadHarnessControl harness={harness} inline />,
        }))}
        onSelect={id => {
          const harness = installedProviderKeys.find(harness => harness === id);
          if (harness) void controller.selectHarness(harness);
        }}
      ><ThreadHarnessControl harness={state.harness} inline /></WorkbenchPressDragMenu>
      <WorkbenchPressDragMenu
        label="Voice model"
        items={models.map(model => ({
          id: model.id, checked: selectedModel === model.id,
          content: <span className="block truncate">{model.displayName || model.id}</span>,
        }))}
        onSelect={id => { void controller.selectModel(id); }}
      >
        {state.catalogue === "loading" ? <LoaderIcon /> : null}
        <span className="max-w-64 truncate">
          {state.models.find(model => model.id === selectedModel)?.displayName || selectedModel || "Select model"}
        </span>
      </WorkbenchPressDragMenu>
      <span role="status" aria-label={state.status} title={state.status} className="inline-flex items-center gap-1 text-xs text-fg/muted">
        {pending ? <LoaderIcon size={12} /> : state.status === "ready" ? <CheckIcon size={12} /> : <XIcon size={12} />}
      </span>
    </div>
    {!state.canToggle ? <p className="m-0 text-xs text-fg/muted">Reload the app database to save browser voice preferences.</p> : null}
    {state.error ? <div role="alert" className="text-sm text-danger">
      {state.error} <button type="button" className="rounded px-2 py-1 hover:bg-button-hover" onClick={() => { void controller.refresh(); }}>Retry</button>
    </div> : null}
    {state.catalogueError ? <div role="alert" className="text-sm text-danger">
      {state.catalogueError} <button type="button" className="rounded px-2 py-1 hover:bg-button-hover" onClick={() => { void controller.loadModels(); }}>Retry models</button>
    </div> : state.catalogue === "ready" && !models.length ? <p role="status" className="m-0 text-xs text-fg/muted">No models available.</p> : null}
    </WorkbenchOptionCard>
  </section>;
}
