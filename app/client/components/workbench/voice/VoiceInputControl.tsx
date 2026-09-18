/*
 * Exports:
 * - useVoiceInput: bind one controlled field to the mounted voice owner.
 * - default VoiceInputControl: accessible hold-to-talk microphone and local status.
 */
import { useContext, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import WorkbenchClientContext from "../workbench-client-context";
import VoiceCaptureController from "../../../workbench/voice/VoiceCaptureController";
import type { VoiceClientSnapshot } from "../../../workbench/voice/WorkbenchVoiceClient";

const idle: VoiceClientSnapshot = { fieldId: null, state: "idle", error: "" };
const subscribeIdle = () => () => {};
const readIdle = () => idle;

export function useVoiceInput(value: string, onChange: ((value: string) => void) | undefined, enabled: boolean) {
  const available = enabled && VoiceCaptureController.isSupported();
  const client = useContext(WorkbenchClientContext)?.mounted?.voice ?? null;
  const fieldId = useId();
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const state = useSyncExternalStore(client?.subscribe ?? subscribeIdle, client?.getSnapshot ?? readIdle, readIdle);
  const active = state.fieldId === fieldId;
  const locked = active && state.state !== "idle" && state.state !== "failed";
  useLayoutEffect(() => { client?.reconcile(fieldId, value); }, [client, fieldId, value]);
  useEffect(() => () => { void client?.cancel(fieldId); }, [client, fieldId]);
  useEffect(() => { if (!available) void client?.cancel(fieldId); }, [client, available, fieldId]);
  return {
    visible: Boolean(client && available && onChange),
    busy: Boolean(state.fieldId && !active && state.state !== "idle" && state.state !== "failed"),
    locked,
    state: active ? state.state : "idle",
    error: active ? state.error : "",
    begin: () => {
      if (!client || !available || !latest.current.onChange) return;
      void client.begin({ id: fieldId, text: latest.current.value, change: text => latest.current.onChange?.(text) })
        .catch(error => console.warn("[voice] could not claim field", error instanceof Error ? error.message : "unknown failure"));
    },
    finish: () => { void client?.finish(fieldId); },
    cancel: () => { void client?.cancel(fieldId); },
  };
}

export default function VoiceInputControl({ voice }: { voice: ReturnType<typeof useVoiceInput> }) {
  const held = useRef(false);
  useEffect(() => {
    if (!voice.locked) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      held.current = false;
      voice.cancel();
    };
    document.addEventListener("keydown", cancel, true);
    return () => document.removeEventListener("keydown", cancel, true);
  }, [voice.locked, voice.cancel]);
  if (!voice.visible) return null;
  const release = () => { if (held.current) { held.current = false; voice.finish(); } };
  return <div className="absolute right-0 bottom-0 z-30 flex items-center gap-1">
    {voice.state !== "idle" ? <span role={voice.error ? "alert" : "status"} className="max-w-48 truncate text-xs text-fg/muted" title={voice.error}>
      {voice.error || voice.state}
    </span> : null}
    <button
      type="button" aria-label="Hold to dictate" aria-pressed={held.current} disabled={voice.busy}
      title={voice.error || "Hold to dictate. Release to finish. Escape to cancel."}
      className="touch-none rounded p-1 text-fg/muted hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] hover:text-text focus-visible:outline focus-visible:outline-accent-soft"
      onPointerDown={event => {
        if (event.button !== 0 || voice.locked) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        held.current = true;
        voice.begin();
      }}
      onPointerUp={release}
      onPointerCancel={() => { held.current = false; voice.cancel(); }}
      onLostPointerCapture={release}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); held.current = false; voice.cancel(); }
        else if ((event.key === " " || event.key === "Enter") && !event.repeat && !voice.locked) {
          event.preventDefault(); event.stopPropagation(); held.current = true; voice.begin();
        }
      }}
      onKeyUp={event => {
        if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); release(); }
      }}
      onBlur={release}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" />
      </svg>
    </button>
  </div>;
}
