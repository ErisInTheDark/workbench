/*
 * Exports:
 * - frameVisDocument: prepend the no-network content policy and the `window.wb` bridge, seeded with the file's synced
 *   control state, to a rendered vis document.
 * - visFrameControlsMessage: the card's message relaying the file's control state into a running frame.
 * - acceptVisFrameControl: the control change a frame message may forward to Workbench, or null.
 * - readVisFrameHeight: the clamped content height a frame message reports, or null.
 * - VIS_FRAME_MIN_HEIGHT/VIS_FRAME_MAX_HEIGHT: bounds of a reported frame height, in CSS pixels.
 */
import { VIS_MAX_CONTROL_ID_LENGTH, VIS_MAX_CONTROL_VALUE_LENGTH, type VisControls } from "./vis-contract";

const CONTROL_KIND = "workbench-vis-control";
const CONTROLS_KIND = "workbench-vis-controls";
const HEIGHT_KIND = "workbench-vis-height";
export const VIS_FRAME_MIN_HEIGHT = 48;
/** Pages sized from the viewport grow with every report; the cap ends that loop. */
export const VIS_FRAME_MAX_HEIGHT = 6_000;

// Inline scripts and styles run; nothing loads from anywhere, though embedded data: images and fonts still work.
const CONTENT_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

/**
 * `wb.state` holds the file's synced controls. A page's own `set` updates it at once and posts the JSON text to the card,
 * which stores it; state the card relays (another device, a later reload) replaces it. Values are copy-on-write, so
 * an unchanged control keeps its identity for React's external-store reads. Embedded pages also report their content
 * height, since the opaque-origin frame cannot be measured from outside.
 */
const BRIDGE_SCRIPT = (initial: string) => `<script>(function(){function post(m){parent.postMessage(m,"*");}`
  + `var has=Object.prototype.hasOwnProperty;var values=${initial};var listeners=[];`
  + `function notify(){listeners.slice().forEach(function(listener){listener();});}`
  + `var state=Object.freeze({`
  + `get:function(id){return has.call(values,id)?values[id]:undefined;},`
  + `set:function(id,value){if(typeof id!=="string"||!id||id.length>${VIS_MAX_CONTROL_ID_LENGTH})throw new TypeError("wb.state.set needs a control id of 1-${VIS_MAX_CONTROL_ID_LENGTH} characters.");`
  + `var json=JSON.stringify(value);if(typeof json!=="string")throw new TypeError("wb.state.set needs a JSON value.");`
  + `if(json.length>${VIS_MAX_CONTROL_VALUE_LENGTH})throw new RangeError("wb.state.set is limited to ${VIS_MAX_CONTROL_VALUE_LENGTH} characters of JSON.");`
  + `var next=Object.assign({},values);next[id]=JSON.parse(json);values=next;notify();post({kind:"${CONTROL_KIND}",id:id,value:json});},`
  + `subscribe:function(listener){listeners.push(listener);return function(){listeners=listeners.filter(function(other){return other!==listener;});};}`
  + `});window.wb=Object.freeze({state:state});`
  + `window.addEventListener("message",function(event){var data=event.data;`
  + `if(event.source!==parent||!data||data.kind!=="${CONTROLS_KIND}"||!data.controls||typeof data.controls!=="object")return;`
  + `var next=Object.assign({},values);var changed=false;`
  + `Object.keys(data.controls).forEach(function(id){var json=data.controls[id];if(typeof json!=="string"||JSON.stringify(next[id])===json)return;`
  + `try{next[id]=JSON.parse(json);changed=true;}catch(error){}});if(changed){values=next;notify();}});`
  + `if(parent===window||typeof ResizeObserver!=="function")return;var last=-1;`
  + `function report(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;post({kind:"${HEIGHT_KIND}",height:h});}}`
  + `var observer=new ResizeObserver(report);observer.observe(document.documentElement);`
  + `document.addEventListener("DOMContentLoaded",function(){if(document.body)observer.observe(document.body);report();});})();</script>`;

/**
 * Stored values are JSON text that already parsed, so they join as-is. `<` only occurs inside JSON strings, where its
 * escape reads back the same while `</script` and `<!--` can never end or re-nest the bridge element.
 */
function controlsLiteral(controls: VisControls) {
  return `{${Object.entries(controls).map(([id, value]) => `${JSON.stringify(id)}:${value}`).join(",")}}`.replaceAll("<", "\\u003c");
}

/** The policy and bridge must come before anything the document runs, but after a doctype, which must stay first. */
export function frameVisDocument(document: string, controls: VisControls) {
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(document);
  const head = `${CONTENT_POLICY}${BRIDGE_SCRIPT(controlsLiteral(controls))}`;
  return doctype ? `${doctype[0]}${head}${document.slice(doctype[0].length)}` : `${head}${document}`;
}

export function visFrameControlsMessage(controls: VisControls) {
  return { kind: CONTROLS_KIND, controls };
}

function messageOf(data: unknown, kind: string): Record<string, unknown> | null {
  return typeof data === "object" && data !== null && "kind" in data && data.kind === kind ? data as Record<string, unknown> : null;
}

/**
 * Frames are sandboxed without same-origin, so their messages carry an opaque origin; the source window is what
 * identifies the card's own frame. Requiring focus means a page can only change state while the user is in it, which
 * is a nudge against unattended changes, not proof the user chose: agents read the state as page-set.
 */
export function acceptVisFrameControl(input: { fromOwnFrame: boolean; frameFocused: boolean; data: unknown }): { id: string; value: string } | null {
  if (!input.fromOwnFrame || !input.frameFocused) return null;
  const message = messageOf(input.data, CONTROL_KIND);
  const id = message?.id;
  const value = message?.value;
  if (typeof id !== "string" || !id || id.length > VIS_MAX_CONTROL_ID_LENGTH) return null;
  if (typeof value !== "string" || !value || value.length > VIS_MAX_CONTROL_VALUE_LENGTH) return null;
  try {
    JSON.parse(value);
  } catch {
    return null;
  }
  return { id, value };
}

/** A height is harmless, so it needs only the card's own frame, not focus. */
export function readVisFrameHeight(input: { fromOwnFrame: boolean; data: unknown }): number | null {
  if (!input.fromOwnFrame) return null;
  const height = messageOf(input.data, HEIGHT_KIND)?.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return Math.min(VIS_FRAME_MAX_HEIGHT, Math.max(VIS_FRAME_MIN_HEIGHT, Math.ceil(height)));
}
