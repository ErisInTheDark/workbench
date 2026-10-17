/*
 * Exports:
 * - installJsdomEnvironment: install one shared jsdom window as browser globals for editor tests, with a minimal layout shim. Runs on import.
 * - flushAnimationFrames: run every queued animation frame; frames never fire on their own.
 */
import { JSDOM } from "jsdom";

let installed: JSDOM | null = null;

const FORCED_GLOBALS = [
  "window", "document", "navigator", "Event", "EventTarget", "CustomEvent", "InputEvent", "KeyboardEvent",
  "MouseEvent", "PointerEvent", "FocusEvent", "ClipboardEvent", "UIEvent", "DOMParser", "Node", "Element",
  "Text", "Range", "Selection", "DocumentFragment", "MutationObserver", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "AbortController", "AbortSignal",
] as const;

const pendingAnimationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrameId = 1;

/** Run queued animation frames now; tests drive frames explicitly so machine load cannot reorder them. */
export function flushAnimationFrames() {
  const frames = [...pendingAnimationFrames.values()];
  pendingAnimationFrames.clear();
  for (const frame of frames) frame(performance.now());
}

function installManualAnimationFrames(window: JSDOM["window"]) {
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId++;
    pendingAnimationFrames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id: number) => { pendingAnimationFrames.delete(id); };
}

/** jsdom has no layout; report a one-line box so caret measurement follows the browser path instead of marker fallbacks. */
function installLayoutShim(window: JSDOM["window"]) {
  const lineRect = () => new window.DOMRect(0, 0, 1, 16);
  const rectList = () => Object.assign([lineRect()], { item: (index: number) => (index === 0 ? lineRect() : null) });
  window.Range.prototype.getBoundingClientRect = lineRect;
  window.Range.prototype.getClientRects = rectList as unknown as Range["getClientRects"];
  window.Element.prototype.getBoundingClientRect = lineRect;
  window.Element.prototype.scrollIntoView = () => {};
}

export function installJsdomEnvironment() {
  if (installed) return installed;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const { window } = dom;
  installLayoutShim(window);
  installManualAnimationFrames(window);
  const target = globalThis as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(window)) {
    if (name in target || name.startsWith("_")) continue;
    target[name] = (window as unknown as Record<string, unknown>)[name];
  }
  for (const name of FORCED_GLOBALS) {
    const value = (window as unknown as Record<string, unknown>)[name];
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: typeof value === "function" && /^[a-z]/u.test(name) ? value.bind(window) : value,
    });
  }
  installed = dom;
  return dom;
}

installJsdomEnvironment();
