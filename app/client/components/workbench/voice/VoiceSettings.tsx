/* Exports:
 * - default VoiceSettings: daemon voice selection using the shared composer profile UI.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { WorkbenchComposerSettings } from "workbench-shared/types";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";
import ThreadProfileQuickPicker from "../thread-view/ThreadProfileQuickPicker";
import ThreadProfileEditor from "../thread-view/ThreadProfileEditor";
import ThreadProfileEditorController from "../thread-view/ThreadProfileEditorController";

const slot = { kind: "voice" } as const;
const defaults: WorkbenchComposerSettings = {
  harness: "codex", model: "gpt-5.6-luna", reasoningEffort: "none",
  agentPath: null, agentSource: null, serviceTier: null, contextWindowTokens: null,
};

export default function VoiceSettings() {
  const daemon = useWorkbenchDaemonClient();
  const profiles = useWorkbenchComposerProfiles();
  const [editor] = useState(() => new ThreadProfileEditorController());
  const catalogue = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const [anchor, setAnchor] = useState<{ trigger: HTMLElement; ribbon: HTMLElement } | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const resolved = profiles.controller.resolveSettings(slot);
  const settings = resolved ?? defaults;
  const configured = resolved !== null;
  const selected = profiles.controller.getSelectedProfile(slot);
  const loadModels = () => { void editor.loadModels(async () => (await daemon.models.list(settings.harness)).data); };
  const loadAgents = () => { void editor.loadAgents(async () => (await daemon.voice.agents()).data); };
  useEffect(() => {
    void profiles.controller.loadSelection(slot);
    void profiles.controller.refreshProfiles();
    return () => editor.reset();
  }, [daemon, profiles.controller, editor]);
  useEffect(() => {
    void editor.loadModels(async () => (await daemon.models.list(settings.harness)).data);
    void editor.loadAgents(async () => (await daemon.voice.agents()).data);
  }, [daemon, editor, settings.harness]);
  useEffect(() => {
    let current = true;
    if (!configured) { setStatus("Not configured"); setError(""); return; }
    setStatus("Preparing");
    setError("");
    void profiles.controller.waitForSelection(slot).then(() => daemon.voice.prepare()).then(() => {
      if (current) setStatus("Ready");
    }, error => {
      if (current) { setStatus("Unavailable"); setError(error instanceof Error ? error.message : "Unable to prepare voice."); }
    });
    return () => { current = false; };
  }, [daemon, profiles.controller, configured, settings.harness, settings.model, settings.reasoningEffort, settings.agentPath]);
  return <section aria-label="Voice input" className="grid gap-2 py-3">
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium">Voice input</span>
      <ThreadProfileQuickPicker
        slot={slot} fallbackSettings={settings} agents={catalogue.agents} models={catalogue.models}
        label={selected?.name || (configured ? "Custom" : "Not configured")}
        selectedLabel={selected?.name || (configured ? settings.model : "Select profile")}
        onOpen={() => { loadModels(); loadAgents(); }}
        onEdit={(trigger, ribbon) => { setAnchor({ trigger, ribbon }); editor.open("profile"); }}
      />
      {configured ? <button type="button" className="rounded px-2 py-1 text-xs text-fg/muted hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]" onClick={() => {
        void profiles.controller.waitForSelection(slot).then(() => daemon.voice.configuration.write({ selection: null })).then(() => {
          profiles.controller.observeSelection(slot, null);
        }, error => setError(error instanceof Error ? error.message : "Unable to clear voice profile."));
      }}>Disable</button> : null}
      <span role="status" className="text-xs text-fg/muted">{status}</span>
    </div>
    {error ? <p role="alert" className="m-0 text-sm text-danger">{error}</p> : null}
    {anchor && catalogue.open ? <ThreadProfileEditor
      anchor={anchor.ribbon} trigger={anchor.trigger} controller={editor}
      slot={slot} fallbackSettings={settings}
      canToggleHarness={false}
      onCustomChange={settings => { void profiles.controller.selectCustom(slot, settings); }}
      onRefreshModels={loadModels} onRefreshAgents={loadAgents}
    /> : null}
  </section>;
}
