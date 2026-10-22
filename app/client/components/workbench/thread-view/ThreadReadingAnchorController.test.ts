/*
 * No exports. Tests protect flow-box selection, hidden boxes never anchoring, transform-free offsets, nested-scroller
 * boundaries, exact-once layout corrections, browser clamps owed back, chrome never holding, held activated controls,
 * and re-anchoring after removal.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import ThreadReadingAnchorController, {
  getThreadContentOffset, pickThreadActivationAnchor, pickThreadReadingAnchor,
} from "./ThreadReadingAnchorController";

interface FakeAnchor { offset: number; connected: boolean }

function fixture() {
  const shifts: number[] = [];
  let atTop: FakeAnchor = { offset: 500, connected: true };
  const controller = new ThreadReadingAnchorController<FakeAnchor>({
    pick: () => atTop,
    offset: anchor => anchor.connected ? anchor.offset : null,
    readScroll: () => ({ max: 10_000, top: 0 }),
    shift: delta => { shifts.push(delta); return delta; },
  });
  controller.record();
  return {
    controller,
    shifts,
    get anchor() { return atTop; },
    scrollTo(next: FakeAnchor) { atTop = next; controller.record(); },
  };
}

test("growth above the anchor moves the reader by exactly that growth", () => {
  const f = fixture();
  f.anchor.offset += 140;
  f.controller.reconcile();
  assert.deepEqual(f.shifts, [140]);
});

test("later ticks of the same content settling are each put back once", () => {
  const f = fixture();
  for (const growth of [112, 85, 140]) {
    f.anchor.offset += growth;
    f.controller.reconcile();
    f.controller.reconcile();
  }
  assert.deepEqual(f.shifts, [112, 85, 140]);
});

test("changes that leave the anchor's content position alone need no correction", () => {
  const f = fixture();
  f.controller.reconcile();
  assert.deepEqual(f.shifts, []);
});

test("a shrink above the reader moves them back up", () => {
  const f = fixture();
  f.anchor.offset -= 300;
  f.controller.reconcile();
  assert.deepEqual(f.shifts, [-300]);
});

test("a correction the scroller can only partly apply at its edge is finished by the next layout change", () => {
  const shifts: number[] = [];
  let scrollTop = 0;
  const anchor = { offset: 500, connected: true };
  const controller = new ThreadReadingAnchorController<FakeAnchor>({
    pick: () => anchor,
    offset: current => current.offset,
    readScroll: () => ({ max: 10_000, top: scrollTop }),
    shift: delta => {
      const next = Math.max(0, scrollTop + delta);
      shifts.push(next - scrollTop);
      const applied = next - scrollTop;
      scrollTop = next;
      return applied;
    },
  });
  controller.record();
  // An old chunk above unmounts while the reader is at the very top: nothing to scroll back.
  anchor.offset -= 276;
  controller.reconcile();
  // Its replacement lands: the reader ends exactly where they were reading.
  anchor.offset += 6_612;
  controller.reconcile();
  assert.deepEqual(shifts, [0, 6_336]);
});

test("a reader the browser clamps at the bottom while a correction is out still lands where they were reading", () => {
  const shifts: number[] = [];
  const scroll = { max: 7_044, top: 4_706 };
  const anchor = { offset: 5_000, connected: true };
  const controller = new ThreadReadingAnchorController<FakeAnchor>({
    pick: () => anchor,
    offset: current => current.offset,
    readScroll: () => ({ ...scroll }),
    shift: delta => {
      const next = Math.min(scroll.max, Math.max(0, scroll.top + delta));
      shifts.push(next - scroll.top);
      const applied = next - scroll.top;
      scroll.top = next;
      return applied;
    },
  });
  controller.record();
  // Chrome below the reader overshoots for one tick, carrying the anchor down with it.
  anchor.offset += 2_284;
  controller.reconcile();
  // Then the page shrinks: the browser clamps the reader to the new bottom, and the anchor is back where it was.
  Object.assign(scroll, { max: 4_760, top: 4_760 });
  anchor.offset -= 2_284;
  controller.reconcile();
  assert.deepEqual(shifts, [2_284, -54]);
  assert.equal(scroll.top, 4_706);
});

test("an unmounted anchor is replaced on the next layout change without inventing a correction", () => {
  const shifts: number[] = [];
  const first = { offset: 100, connected: true };
  const second = { offset: 400, connected: true };
  let atTop = first;
  const controller = new ThreadReadingAnchorController<FakeAnchor>({
    pick: () => atTop,
    offset: anchor => anchor.connected ? anchor.offset : null,
    readScroll: () => ({ max: 10_000, top: 0 }),
    shift: delta => { shifts.push(delta); return delta; },
  });
  controller.record();
  first.connected = false;
  atTop = second;
  controller.reconcile();
  second.offset += 30;
  controller.reconcile();
  assert.deepEqual(shifts, [30]);
});

test("growth the reader scrolls past before any observer reports it is still put back", () => {
  const f = fixture();
  f.anchor.offset += 50;
  f.scrollTo({ offset: 1200, connected: true });
  f.controller.reconcile();
  assert.deepEqual(f.shifts, [50]);
});

test("scrolling re-anchors, so movement the reader made is never corrected", () => {
  const f = fixture();
  f.scrollTo({ offset: 1200, connected: true });
  f.controller.reconcile();
  assert.deepEqual(f.shifts, []);
});

test("an activated control holds still while content below it grows past the reading line", () => {
  const f = fixture();
  const control = { offset: 200, connected: true };
  f.controller.hold(control);
  f.anchor.offset += 400;
  f.controller.reconcile();
  control.offset += 60;
  f.controller.reconcile();
  assert.deepEqual(f.shifts, [60]);
});

test("drift that landed before a control was activated is still put back", () => {
  const f = fixture();
  f.anchor.offset += 90;
  f.controller.hold({ offset: 200, connected: true });
  assert.deepEqual(f.shifts, [90]);
});

test("a held control is let go once the reader scrolls", () => {
  const f = fixture();
  const control = { offset: 200, connected: true };
  f.controller.hold(control);
  f.scrollTo({ offset: 1200, connected: true });
  control.offset += 60;
  f.controller.reconcile();
  assert.deepEqual(f.shifts, []);
});

function layoutFixture(t: TestContext) {
  const styles = new WeakMap<Element, { display: string; position: string; overflowY: string }>();
  class LayoutElement {}
  for (const [name, value] of Object.entries({
    HTMLElement: LayoutElement,
    getComputedStyle: (element: Element) => styles.get(element),
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const box = (top: number, height: number, children: HTMLElement[] = [], display = "block", position = "static",
    overflowY = "visible", scrollHeight = height) => {
    const element = {
      dataset: {},
      clientHeight: height,
      scrollHeight,
      getBoundingClientRect: (): DOMRect => ({
        x: 0, y: top, top, bottom: top + height, left: 0, right: 400, width: 400, height,
        toJSON: () => ({ top, height }),
      }),
    } as HTMLElement;
    Object.setPrototypeOf(element, LayoutElement.prototype);
    Object.defineProperty(element, "children", { value: children });
    Object.defineProperty(element, "parentElement", { value: null, writable: true });
    for (const child of children) (child as { parentElement: Element | null }).parentElement = element;
    styles.set(element, { display, position, overflowY });
    return element;
  };
  const viewport = box(0, 600);
  return { box, styles, viewport };
}

test("a nested scroller remains the anchor instead of the lines it scrolls", t => {
  const { box, viewport } = layoutFixture(t);
  for (const [overflowY, scrollHeight] of [["auto", 200], ["scroll", 900], ["hidden", 900]] as const) {
    const scroller = box(100, 400, [box(-200, 900, [box(250, 20)])], "block", "static", overflowY, scrollHeight);
    assert.equal(pickThreadReadingAnchor(viewport, box(0, 600, [scroller])), scroller);
  }
});

test("a control inside nested scrollers is held by the outermost scroller carrying it", t => {
  const { box } = layoutFixture(t);
  const control = box(250, 20);
  const inner = box(200, 100, [box(150, 300, [control])], "block", "static", "auto");
  const outer = box(100, 400, [box(100, 400, [inner])], "block", "static", "auto");
  const content = box(0, 600, [outer]);
  assert.equal(pickThreadActivationAnchor(control, content), outer);
  const plain = box(250, 20);
  assert.equal(pickThreadActivationAnchor(plain, box(0, 600, [box(0, 600, [plain])])), plain);
});

test("a clipping box with nothing to scroll still exposes its children", t => {
  const { box, viewport } = layoutFixture(t);
  const reading = box(250, 100);
  const clip = box(100, 400, [reading], "block", "static", "hidden");
  assert.equal(pickThreadReadingAnchor(viewport, box(0, 600, [clip])), reading);
});

test("boxless chrome after the transcript does not hide the reading anchor", t => {
  const { box, viewport } = layoutFixture(t);
  const reading = box(250, 100);
  const transcript = box(-1000, 2000, [reading]);
  const chrome = box(0, 0, [box(1000, 200)], "contents");
  const content = box(-1000, 2200, [transcript, chrome]);
  assert.equal(pickThreadReadingAnchor(viewport, content), reading);
});

test("nested boxless wrappers expose their flow children to anchoring", t => {
  const { box, viewport } = layoutFixture(t);
  const reading = box(250, 100);
  const wrapper = box(0, 0, [box(0, 0, [reading], "contents")], "contents");
  const content = box(-1000, 2200, [wrapper]);
  assert.equal(pickThreadReadingAnchor(viewport, content), reading);
});

test("positioned and hidden siblings cannot redirect the flow search", t => {
  const { box, viewport } = layoutFixture(t);
  const reading = box(250, 100);
  for (const [display, position] of [["block", "sticky"], ["block", "absolute"], ["block", "fixed"], ["none", "static"]]) {
    const content = box(-1000, 2200, [reading, box(0, 20, [], display, position)]);
    assert.equal(pickThreadReadingAnchor(viewport, content), reading);
  }
});

test("boxes the reader cannot see never become the anchor", t => {
  const { box, viewport } = layoutFixture(t);
  const reading = box(250, 100);
  const hidden = box(240, 120, [box(250, 20)]);
  Object.assign(hidden, { checkVisibility: () => false });
  const icon = box(200, 200);
  Object.setPrototypeOf(icon, Object.prototype);
  const spacer = box(0, 600);
  Object.assign(spacer, { ariaHidden: "true" });
  assert.equal(pickThreadReadingAnchor(viewport, box(0, 600, [spacer, hidden, icon, reading])), reading);
});

function offsetFixture(t: TestContext) {
  const { styles } = layoutFixture(t);
  /** A box laid out `offsetTop` below its offset parent, nested in `parent`. */
  return (offsetTop: number, offsetParent: HTMLElement | null, { clientTop = 0, parent = offsetParent, position = "static" } = {}) => {
    const element = Object.create(HTMLElement.prototype) as HTMLElement;
    Object.defineProperties(element, {
      clientTop: { value: clientTop }, offsetParent: { value: offsetParent }, offsetTop: { value: offsetTop }, parentElement: { value: parent },
    });
    styles.set(element, { display: "block", overflowY: "visible", position });
    return element;
  };
}

test("an anchor's content offset follows layout, not transforms", t => {
  const positioned = offsetFixture(t);
  const page = positioned(0, null);
  const viewport = positioned(40, page, { clientTop: 2 });
  const content = positioned(10, viewport);
  const card = positioned(300, viewport, { clientTop: 1, parent: content, position: "relative" });
  const row = positioned(25, card, { clientTop: 4 });
  // The rows' getBoundingClientRect would include any running animation; the offset never reads it.
  assert.equal(getThreadContentOffset(row, content), 316);
});

for (const position of ["sticky", "fixed"]) {
  test(`an anchor in ${position} chrome has no content offset, since its layout moves with the scroll, not the content`, t => {
    const positioned = offsetFixture(t);
    const viewport = positioned(0, null);
    const content = positioned(0, viewport);
    const chrome = positioned(900, viewport, { parent: content, position });
    const control = positioned(12, chrome);
    assert.equal(getThreadContentOffset(control, content), null);
  });
}

test("a measured placeholder remains the anchor instead of its skipped descendants", t => {
  const { box, viewport } = layoutFixture(t);
  const placeholder = box(250, 100, [box(0, 0)]);
  placeholder.dataset.threadMeasuredContent = "placeholder";
  assert.equal(pickThreadReadingAnchor(viewport, box(0, 600, [placeholder])), placeholder);
});
