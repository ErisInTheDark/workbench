/*
 * Exports:
 * - VIS_SERVED_CONTENT_POLICY: the header policy of pages on the vis origin: anything from that origin, nothing from any other.
 * - VIS_FRAME_SANDBOX/VIS_STANDALONE_SANDBOX: frame sandboxes for served pages (same-origin only with the vis origin,
 *   never the app's) and for standalone documents (opaque).
 * - frameVisDocument: prepend the `window.wb` bridge, seeded with the file's synced control state, the app's palette and
 *   who is looking (VisAudience), to a rendered vis document; standalone pages also get a no-network policy.
 * - hostVisFrame: a page holding one served vis in the card's sandbox, sized by the height it reports, for headless checks.
 * - visFrameControlsMessage: the card's message relaying the file's control state into a running frame.
 * - visFrameThemeMessage: the card's message repainting a running frame in the app's palette.
 * - acceptVisFrameControl: the control change a frame message may forward to Workbench, or null.
 * - readVisFrameHeight: the clamped content height a frame message reports, or null.
 * - VIS_FRAME_MIN_HEIGHT/VIS_FRAME_MAX_HEIGHT: bounds of a reported frame height, in CSS pixels.
 */
import type { WorkbenchTheme } from "../settings/workbench-setting-definitions";
import { VIS_MAX_CONTROL_ID_LENGTH, VIS_MAX_CONTROL_VALUE_LENGTH, type VisControls } from "./vis-contract";

const CONTROL_KIND = "workbench-vis-control";
const CONTROLS_KIND = "workbench-vis-controls";
const HEIGHT_KIND = "workbench-vis-height";
const THEME_KIND = "workbench-vis-theme";
export const VIS_FRAME_MIN_HEIGHT = 48;
/** Pages sized from the viewport grow with every report; the cap ends that loop. */
export const VIS_FRAME_MAX_HEIGHT = 6_000;

// Standalone pages (component previews) have no origin to load from: inline code and embedded data only.
const STANDALONE_CONTENT_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

export const VIS_SERVED_CONTENT_POLICY = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; base-uri 'self'; form-action 'self'";

export const VIS_FRAME_SANDBOX = "allow-scripts allow-same-origin";
/** Standalone documents have no origin of their own to share, so they stay opaque. */
export const VIS_STANDALONE_SANDBOX = "allow-scripts";

/**
 * `wb.state` holds the file's synced controls. A page's own `set` updates it at once and posts the JSON text to the card,
 * which stores it; state the card relays (another device, a later reload) replaces it. Values are copy-on-write, so
 * an unchanged control keeps its identity for React's external-store reads. Embedded pages also report their content
 * height, since the opaque-origin frame cannot be measured from outside.
 */
const BRIDGE_SCRIPT = (initial: string, theme: WorkbenchTheme | null, audience: VisAudience) => `<script>(function(){function post(m){parent.postMessage(m,"*");}`
  + `var root=document.documentElement;function theme(name){if(root&&typeof name==="string"&&/^[a-z-]{1,32}$/.test(name))root.setAttribute("data-workbench-theme",name);}`
  + `theme(${JSON.stringify(theme)});`
  + `var has=Object.prototype.hasOwnProperty;var values=${initial};var listeners=[];`
  + `function notify(){listeners.slice().forEach(function(listener){listener();});}`
  + `var state=Object.freeze({`
  + `get:function(id){return has.call(values,id)?values[id]:undefined;},`
  + `set:function(id,value){if(typeof id!=="string"||!id||id.length>${VIS_MAX_CONTROL_ID_LENGTH})throw new TypeError("wb.state.set needs a control id of 1-${VIS_MAX_CONTROL_ID_LENGTH} characters.");`
  + `var json=JSON.stringify(value);if(typeof json!=="string")throw new TypeError("wb.state.set needs a JSON value.");`
  + `if(json.length>${VIS_MAX_CONTROL_VALUE_LENGTH})throw new RangeError("wb.state.set is limited to ${VIS_MAX_CONTROL_VALUE_LENGTH} characters of JSON.");`
  + `var next=Object.assign({},values);next[id]=JSON.parse(json);values=next;notify();post({kind:"${CONTROL_KIND}",id:id,value:json});},`
  + `subscribe:function(listener){listeners.push(listener);return function(){listeners=listeners.filter(function(other){return other!==listener;});};}`
  + `});window.wb=Object.freeze({state:state,audience:${JSON.stringify(audience)}});`
  + `window.addEventListener("message",function(event){var data=event.data;if(event.source!==parent||!data)return;`
  + `if(data.kind==="${THEME_KIND}"){theme(data.theme);return;}`
  + `if(data.kind!=="${CONTROLS_KIND}"||!data.controls||typeof data.controls!=="object")return;`
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

/** Who looks at a framed page: the user's card, or the agent's headless checks. */
export type VisAudience = "user" | "agent";

/**
 * The policy and bridge must come before anything the document runs, but after a doctype, which must stay first.
 * `theme` paints the page in the app's palette from its first frame; without one the page keeps the default palette.
 * Served pages take their policy from the response header instead, which a meta policy could only narrow.
 */
export function frameVisDocument(document: string, controls: VisControls, { audience = "user", served = false, theme = null }: {
  audience?: VisAudience; served?: boolean; theme?: WorkbenchTheme | null;
} = {}) {
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(document);
  const head = `${served ? "" : STANDALONE_CONTENT_POLICY}${BRIDGE_SCRIPT(controlsLiteral(controls), theme, audience)}`;
  return doctype ? `${doctype[0]}${head}${document.slice(doctype[0].length)}` : `${head}${document}`;
}

function attribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

/** Hosts the page the way the card does, so a check sees the card's origin rules and content height. */
export function hostVisFrame(url: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{display:block;width:100%;height:${VIS_FRAME_MIN_HEIGHT}px;border:0}</style></head>`
    + `<body><iframe sandbox="${VIS_FRAME_SANDBOX}" src="${attribute(url)}" title="vis"></iframe>`
    + `<script>(function(){var frame=document.querySelector("iframe");addEventListener("message",function(event){`
    + `var data=event.data;if(event.source!==frame.contentWindow||!data||data.kind!=="${HEIGHT_KIND}"||typeof data.height!=="number"||!isFinite(data.height))return;`
    + `frame.style.height=Math.min(${VIS_FRAME_MAX_HEIGHT},Math.max(${VIS_FRAME_MIN_HEIGHT},Math.ceil(data.height)))+"px";});})();</script></body></html>`;
}

export function visFrameControlsMessage(controls: VisControls) {
  return { kind: CONTROLS_KIND, controls };
}

/** Repaints a running page in the app's new palette without reloading it. */
export function visFrameThemeMessage(theme: WorkbenchTheme) {
  return { kind: THEME_KIND, theme };
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
