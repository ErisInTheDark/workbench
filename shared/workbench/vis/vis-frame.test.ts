/* No production exports. Protect the vis frame bridge: injected control state, page-set controls and parent-synced controls, which frame messages become control changes (own focused frame, bounded id and JSON) and frame heights. */
import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { VIS_MAX_CONTROL_VALUE_LENGTH } from "./vis-contract";
import {
  acceptVisFrameControl, frameVisDocument, readVisFrameHeight, VIS_FRAME_MAX_HEIGHT, VIS_FRAME_MIN_HEIGHT, visFrameControlsMessage,
} from "./vis-frame";

const control = (id: unknown, value: unknown) => ({ kind: "workbench-vis-control", id, value });
const height = (value: unknown) => ({ kind: "workbench-vis-height", height: value });

interface FakeState { get(id: string): unknown; set(id: string, value: unknown): void; subscribe(listener: () => void): () => void }

/** Runs the framed document's bridge script against a fake window, as the frame would. */
function bridge(controls: Record<string, string>) {
  const framed = frameVisDocument("<!doctype html><p>page</p>", controls);
  const scripts = [...framed.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(match => match[1]!);
  const posted: unknown[] = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const handlers: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const window: Record<string, unknown> = { addEventListener: (_kind: string, handler: (typeof handlers)[number]) => handlers.push(handler) };
  for (const script of scripts) runInNewContext(script, { window, parent, document: {}, JSON, Object });
  const state = (window.wb as { state: FakeState }).state;
  return { framed, posted, state, deliver: (source: unknown, data: unknown) => handlers.forEach(handler => handler({ source, data })), parent };
}

test("a framed page starts from the injected control state, which cannot break out of its script", () => {
  const { framed, state } = bridge({ tab: "\"card\"", note: JSON.stringify("</script><script>alert(1)</script>") });
  assert.equal(state.get("tab"), "card");
  assert.equal(state.get("note"), "</script><script>alert(1)</script>");
  assert.equal(state.get("missing"), undefined);
  assert.equal(framed.match(/<\/script>/gu)?.length, 1, "only the bridge's own closing tag");
});

test("setting a control updates the page, tells subscribers and posts it to the card", () => {
  const { posted, state } = bridge({});
  let notified = 0;
  state.subscribe(() => { notified += 1; });
  state.set("tab", { pick: "step" });
  // The bridge runs in another realm, so its objects compare by content.
  assert.equal(JSON.stringify(state.get("tab")), "{\"pick\":\"step\"}");
  assert.equal(notified, 1);
  assert.equal(JSON.stringify(posted), JSON.stringify([control("tab", "{\"pick\":\"step\"}")]));
});

test("control state the card relays from elsewhere replaces the page's, and other windows cannot", () => {
  const { deliver, parent, state } = bridge({ tab: "\"current\"" });
  const before = state.get("tab");
  deliver({}, visFrameControlsMessage({ tab: "\"card\"" }));
  assert.equal(state.get("tab"), before);
  deliver(parent, visFrameControlsMessage({ tab: "\"card\"" }));
  assert.equal(state.get("tab"), "card");
});

test("the card's own focused frame can set a control", () => {
  assert.deepEqual(acceptVisFrameControl({ fromOwnFrame: true, frameFocused: true, data: control("tab", "\"a\"") }), { id: "tab", value: "\"a\"" });
});

test("control messages from other windows, or while the frame is unfocused, are dropped", () => {
  assert.equal(acceptVisFrameControl({ fromOwnFrame: false, frameFocused: true, data: control("tab", "1") }), null);
  assert.equal(acceptVisFrameControl({ fromOwnFrame: true, frameFocused: false, data: control("tab", "1") }), null);
});

test("malformed ids, non-JSON and oversized values are dropped", () => {
  for (const data of [
    null, "1", { kind: "other", id: "tab", value: "1" }, control("", "1"), control("x".repeat(201), "1"), control(1, "1"),
    control("tab", 1), control("tab", ""), control("tab", "{nope"), control("tab", `"${"x".repeat(VIS_MAX_CONTROL_VALUE_LENGTH)}"`),
  ]) {
    assert.equal(acceptVisFrameControl({ fromOwnFrame: true, frameFocused: true, data }), null);
  }
});

test("frame heights come only from the card's own frame and stay within bounds", () => {
  assert.equal(readVisFrameHeight({ fromOwnFrame: true, data: height(320.2) }), 321);
  assert.equal(readVisFrameHeight({ fromOwnFrame: true, data: height(0) }), VIS_FRAME_MIN_HEIGHT);
  assert.equal(readVisFrameHeight({ fromOwnFrame: true, data: height(1e9) }), VIS_FRAME_MAX_HEIGHT);
  assert.equal(readVisFrameHeight({ fromOwnFrame: false, data: height(320) }), null);
  for (const data of [height("320"), height(Number.NaN), control("tab", "1"), null]) {
    assert.equal(readVisFrameHeight({ fromOwnFrame: true, data }), null);
  }
});
