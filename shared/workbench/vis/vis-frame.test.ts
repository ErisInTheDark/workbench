/* No production exports. Protect the vis frame bridge: the app's palette, injected control state, page-set controls and parent-synced controls, which frame messages become control changes (own focused frame, bounded id and JSON), frame heights, and when an agent's check page counts as settled. */
import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { VIS_MAX_CONTROL_VALUE_LENGTH } from "./vis-contract";
import {
  acceptVisFrameControl, frameVisDocument, hostVisFrame, readVisFrameHeight, VIS_FRAME_MAX_HEIGHT, VIS_FRAME_MIN_HEIGHT,
  VIS_FRAME_QUIET_MS, VIS_FRAME_SETTLE_LIMIT_MS, VIS_HOST_SETTLED_GLOBAL, visFrameControlsMessage, visFrameThemeMessage,
  type VisFrameSettle,
} from "./vis-frame";

const control = (id: unknown, value: unknown) => ({ kind: "workbench-vis-control", id, value });
const height = (value: unknown) => ({ kind: "workbench-vis-height", height: value });

interface FakeState { get(id: string): unknown; set(id: string, value: unknown): void; subscribe(listener: () => void): () => void }

/** A manual clock for page timers. */
function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimeout: (run: () => void, ms: number) => { timers.set(nextId, { at: now + ms, run }); return nextId++; },
    clearTimeout: (id: number) => { timers.delete(id); },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort(([, left], [, right]) => left.at - right.at)) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

interface PageGlobals {
  setTimeout(callback: () => void, ms?: number): number;
  clearTimeout(id: number): void;
  fetch(url: string): Promise<unknown>;
  XMLHttpRequest: new () => { send(): void };
}

/** Runs the framed document's bridge script against a fake window, which is also the page's global scope, as in a frame. */
function bridge(controls: Record<string, string>, options: Parameters<typeof frameVisDocument>[2] = {}) {
  const framed = frameVisDocument("<!doctype html><p>page</p>", controls, options);
  const scripts = [...framed.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(match => match[1]!);
  const posted: unknown[] = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const handlers = new Map<string, Array<(event: { source: unknown; data: unknown }) => void>>();
  const addEventListener = (kind: string, handler: (event: { source: unknown; data: unknown }) => void) => {
    handlers.set(kind, [...handlers.get(kind) ?? [], handler]);
  };
  const attributes: Record<string, string> = {};
  const documentElement = { setAttribute: (name: string, value: string) => { attributes[name] = value; } };
  const mutations: Array<() => void> = [];
  const resources: Array<() => void> = [];
  const requests: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = [];
  const time = clock();
  const window: Record<string, unknown> = {
    addEventListener, parent, document: { documentElement }, JSON, Object, Array,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    fetch: () => new Promise((resolve, reject) => { requests.push({ resolve, reject }); }),
    XMLHttpRequest: class {
      readonly #finished: Array<() => void> = [];
      addEventListener(_kind: string, listener: () => void) { this.#finished.push(listener); }
      send() { requests.push({ resolve: () => this.#finished.forEach(listener => listener()), reject: () => undefined }); }
    },
    MutationObserver: class { constructor(callback: () => void) { mutations.push(callback); } observe() {} },
    PerformanceObserver: class { constructor(callback: () => void) { resources.push(callback); } observe() {} },
  };
  window.window = window;
  for (const script of scripts) runInNewContext(script, window);
  const { audience, state } = window.wb as { audience: string; state: FakeState };
  const dispatch = (kind: string, source: unknown = null, data: unknown = null) => handlers.get(kind)?.forEach(handler => handler({ source, data }));
  return {
    attributes, audience, framed, posted, state, parent, clock: time, dispatch, requests,
    page: window as unknown as PageGlobals,
    watching: mutations.length + resources.length > 0,
    mutate: () => mutations.forEach(callback => callback()),
    loadResource: () => resources.forEach(callback => callback()),
    deliver: (source: unknown, data: unknown) => dispatch("message", source, data),
    settledCount: () => posted.filter(message => (message as { kind?: unknown }).kind === "workbench-vis-settled").length,
  };
}

/** Runs the check page's script, as the headless browser would. */
function host() {
  const script = /<script>([\s\S]*?)<\/script>/u.exec(hostVisFrame("http://127.0.0.1:4000/daemon/vis/x/live/"))![1]!;
  const frame = { contentWindow: {}, style: {} };
  const handlers: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const time = clock();
  const page: Record<string, unknown> = {
    document: { querySelector: () => frame },
    addEventListener: (kind: string, handler: (typeof handlers)[number]) => { if (kind === "message") handlers.push(handler); },
    setTimeout: time.setTimeout, Math, isFinite,
  };
  page.window = page;
  runInNewContext(script, page);
  return {
    frame, clock: time,
    settled: page[VIS_HOST_SETTLED_GLOBAL] as Promise<VisFrameSettle>,
    deliver: (source: unknown, data: unknown) => handlers.forEach(handler => handler({ source, data })),
  };
}

const SETTLED = { kind: "workbench-vis-settled" };

test("an agent's check frame settles only after load and a quiet spell, which any change or resource load restarts", () => {
  const page = bridge({}, { audience: "agent" });
  page.mutate();
  page.clock.advance(VIS_FRAME_QUIET_MS * 4);
  assert.equal(page.settledCount(), 0, "nothing settles before the page loads");
  page.dispatch("load");
  page.clock.advance(VIS_FRAME_QUIET_MS - 1);
  page.mutate();
  page.clock.advance(VIS_FRAME_QUIET_MS - 1);
  page.loadResource();
  page.clock.advance(VIS_FRAME_QUIET_MS - 1);
  assert.equal(page.settledCount(), 0);
  page.clock.advance(1);
  assert.equal(page.settledCount(), 1);
});

test("a pending boot timer holds settling until it fires, however quiet the page is meanwhile", () => {
  const page = bridge({}, { audience: "agent" });
  page.page.setTimeout(() => page.mutate(), 2_000);
  page.dispatch("load");
  page.clock.advance(1_999);
  assert.equal(page.settledCount(), 0);
  page.clock.advance(1);
  page.clock.advance(VIS_FRAME_QUIET_MS - 1);
  assert.equal(page.settledCount(), 0, "what the timer did still needs a quiet spell");
  page.clock.advance(1);
  assert.equal(page.settledCount(), 1);
});

test("a cleared timer, or one past the settle limit, holds nothing", () => {
  const page = bridge({}, { audience: "agent" });
  const id = page.page.setTimeout(() => undefined, 1_000);
  page.page.setTimeout(() => undefined, VIS_FRAME_SETTLE_LIMIT_MS + 1);
  page.dispatch("load");
  page.page.clearTimeout(id);
  page.clock.advance(VIS_FRAME_QUIET_MS);
  assert.equal(page.settledCount(), 1);
});

test("an in-flight fetch or request holds settling until it finishes, failed or not", async () => {
  const page = bridge({}, { audience: "agent" });
  const fetched = page.page.fetch("data.json").catch(() => undefined);
  new page.page.XMLHttpRequest().send();
  page.dispatch("load");
  page.clock.advance(VIS_FRAME_QUIET_MS * 4);
  page.requests[1]!.resolve(null);
  page.clock.advance(VIS_FRAME_QUIET_MS * 4);
  assert.equal(page.settledCount(), 0, "the fetch is still out");
  page.requests[0]!.reject(new Error("offline"));
  await fetched;
  page.clock.advance(VIS_FRAME_QUIET_MS);
  assert.equal(page.settledCount(), 1);
});

test("the user's card frame never watches for settling", () => {
  const page = bridge({});
  page.dispatch("load");
  page.clock.advance(VIS_FRAME_QUIET_MS * 4);
  assert.deepEqual([page.watching, page.settledCount()], [false, 0]);
});

test("the check page settles on its own frame's word, or gives up as busy at the limit", async () => {
  const quiet = host();
  quiet.clock.advance(VIS_FRAME_SETTLE_LIMIT_MS - 1);
  quiet.deliver(quiet.frame.contentWindow, SETTLED);
  assert.equal(await quiet.settled, "quiet");

  const busy = host();
  busy.deliver({}, SETTLED);
  busy.deliver(busy.frame.contentWindow, { kind: "workbench-vis-height", height: 100 });
  busy.clock.advance(VIS_FRAME_SETTLE_LIMIT_MS);
  assert.equal(await busy.settled, "busy", "only its own frame's settled message counts");
});

test("a framed page paints in the app's palette from the start and follows the card's changes, never another window's", () => {
  const { attributes, deliver, parent } = bridge({}, { theme: "magical-girl" });
  assert.equal(attributes["data-workbench-theme"], "magical-girl");
  deliver({}, visFrameThemeMessage("winter"));
  assert.equal(attributes["data-workbench-theme"], "magical-girl");
  for (const theme of ["\"><script>", "", 1, "x".repeat(33)]) deliver(parent, { kind: "workbench-vis-theme", theme });
  assert.equal(attributes["data-workbench-theme"], "magical-girl");
  deliver(parent, visFrameThemeMessage("winter"));
  assert.equal(attributes["data-workbench-theme"], "winter");
});

test("a framed page starts from the injected control state, which cannot break out of its script", () => {
  const { framed, state } = bridge({ tab: "\"card\"", note: JSON.stringify("</script><script>alert(1)</script>") });
  assert.equal(state.get("tab"), "card");
  assert.equal(state.get("note"), "</script><script>alert(1)</script>");
  assert.equal(state.get("missing"), undefined);
  assert.equal(framed.match(/<\/script>/gu)?.length, 1, "only the bridge's own closing tag");
});

test("a page knows whether the user's card or the agent's headless check is showing it", () => {
  assert.equal(bridge({}).audience, "user");
  assert.equal(bridge({}, { audience: "agent" }).audience, "agent");
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
