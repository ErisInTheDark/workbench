/*
 * Exports:
 * - frameVisDocument: prepend the no-network content policy and the `window.wb` bridge to a rendered vis document.
 * - acceptVisFrameAnswer: the JSON text of a frame message the card may forward as an answer, or null.
 * - readVisFrameHeight: the clamped content height a frame message reports, or null.
 * - VIS_FRAME_MIN_HEIGHT/VIS_FRAME_MAX_HEIGHT: bounds of a reported frame height, in CSS pixels.
 */
import { VIS_MAX_ANSWER_LENGTH } from "./vis-contract";

const ANSWER_KIND = "workbench-vis-answer";
const HEIGHT_KIND = "workbench-vis-height";
export const VIS_FRAME_MIN_HEIGHT = 48;
/** Pages sized from the viewport grow with every report; the cap ends that loop. */
export const VIS_FRAME_MAX_HEIGHT = 6_000;

// Inline scripts and styles run; nothing loads from anywhere, though embedded data: images and fonts still work.
const CONTENT_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;

/**
 * Serializes answers in the page, so the parent only ever sees a string it can bound before parsing anything.
 * Embedded pages also report their content height, since the opaque-origin frame cannot be measured from outside.
 */
const BRIDGE_SCRIPT = `<script>(function(){function post(m){parent.postMessage(m,"*");}`
  + `window.wb=Object.freeze({send:function(value){var json=JSON.stringify(value);if(typeof json!=="string")throw new TypeError("wb.send needs a JSON value.");if(json.length>${VIS_MAX_ANSWER_LENGTH})throw new RangeError("wb.send is limited to ${VIS_MAX_ANSWER_LENGTH} characters of JSON.");post({kind:"${ANSWER_KIND}",value:json});}});`
  + `if(parent===window||typeof ResizeObserver!=="function")return;var last=-1;`
  + `function report(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;post({kind:"${HEIGHT_KIND}",height:h});}}`
  + `var observer=new ResizeObserver(report);observer.observe(document.documentElement);`
  + `document.addEventListener("DOMContentLoaded",function(){if(document.body)observer.observe(document.body);report();});})();</script>`;

/** The policy and bridge must come before anything the document runs, but after a doctype, which must stay first. */
export function frameVisDocument(document: string) {
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(document);
  const head = `${CONTENT_POLICY}${BRIDGE_SCRIPT}`;
  return doctype ? `${doctype[0]}${head}${document.slice(doctype[0].length)}` : `${head}${document}`;
}

function messageOf(data: unknown, kind: string): Record<string, unknown> | null {
  return typeof data === "object" && data !== null && "kind" in data && data.kind === kind ? data as Record<string, unknown> : null;
}

/**
 * Frames are sandboxed without same-origin, so their messages carry an opaque origin; the source window is what
 * identifies the card's own frame. Requiring focus means a page can only answer while the user is in it, which is
 * a nudge against unattended sends, not proof the user chose: agents read answers as page-sent.
 */
export function acceptVisFrameAnswer(input: { fromOwnFrame: boolean; frameFocused: boolean; data: unknown }): string | null {
  if (!input.fromOwnFrame || !input.frameFocused) return null;
  const value = messageOf(input.data, ANSWER_KIND)?.value;
  if (typeof value !== "string" || !value || value.length > VIS_MAX_ANSWER_LENGTH) return null;
  try {
    JSON.parse(value);
  } catch {
    return null;
  }
  return value;
}

/** A height is harmless, so it needs only the card's own frame, not focus. */
export function readVisFrameHeight(input: { fromOwnFrame: boolean; data: unknown }): number | null {
  if (!input.fromOwnFrame) return null;
  const height = messageOf(input.data, HEIGHT_KIND)?.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return Math.min(VIS_FRAME_MAX_HEIGHT, Math.max(VIS_FRAME_MIN_HEIGHT, Math.ceil(height)));
}
