/*
 * Exports:
 * - VIS_BRIDGE_SCRIPT: the `window.wb` bridge injected into every vis frame.
 * - acceptVisFrameAnswer: the JSON text of a frame message the card may forward as an answer, or null.
 */
import { VIS_MAX_ANSWER_LENGTH } from "workbench-shared/workbench/vis/vis-contract";

const MESSAGE_KIND = "workbench-vis-answer";

/** Serializes in the page, so the parent only ever sees a string it can bound before parsing anything. */
export const VIS_BRIDGE_SCRIPT = `<script>window.wb=Object.freeze({send:function(value){var json=JSON.stringify(value);if(typeof json!=="string")throw new TypeError("wb.send needs a JSON value.");if(json.length>${VIS_MAX_ANSWER_LENGTH})throw new RangeError("wb.send is limited to ${VIS_MAX_ANSWER_LENGTH} characters of JSON.");parent.postMessage({kind:"${MESSAGE_KIND}",value:json},"*");}});</script>`;

/**
 * Frames are sandboxed without same-origin, so their messages carry an opaque origin; the source window is what
 * identifies the card's own frame. Requiring focus means a page can only answer while the user is in it, which is
 * a nudge against unattended sends, not proof the user chose: agents read answers as page-sent.
 */
export function acceptVisFrameAnswer(input: { fromOwnFrame: boolean; frameFocused: boolean; data: unknown }): string | null {
  if (!input.fromOwnFrame || !input.frameFocused) return null;
  const data = input.data;
  if (typeof data !== "object" || data === null || !("kind" in data) || data.kind !== MESSAGE_KIND || !("value" in data)) return null;
  const value = data.value;
  if (typeof value !== "string" || !value || value.length > VIS_MAX_ANSWER_LENGTH) return null;
  try {
    JSON.parse(value);
  } catch {
    return null;
  }
  return value;
}
