/*
 * No exports. Tests protect flow-box selection, exact-once layout corrections, and re-anchoring after removal.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import ThreadReadingAnchorController, { pickThreadReadingAnchor } from "./ThreadReadingAnchorController";

interface FakeAnchor { offset: number; connected: boolean }

function fixture() {
  const shifts: number[] = [];
  let atTop: FakeAnchor = { offset: 500, connected: true };
  const controller = new ThreadReadingAnchorController<FakeAnchor>({
    pick: () => atTop,
    offset: anchor => anchor.connected ? anchor.offset : null,
    shift: delta => shifts.push(delta),
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

test("an unmounted anchor is replaced on the next layout change without inventing a correction", () => {
  const shifts: number[] = [];
  const first = { offset: 100, connected: true };
  const second = { offset: 400, connected: true };
  let atTop = first;
  const controller = new ThreadReadingAnchorController<FakeAnchor>({
    pick: () => atTop,
    offset: anchor => anchor.connected ? anchor.offset : null,
    shift: delta => shifts.push(delta),
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

function layoutFixture(t: TestContext) {
  const styles = new WeakMap<Element, { display: string; position: string }>();
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
  const box = (top: number, height: number, children: HTMLElement[] = [], display = "block", position = "static") => {
    const element = {
      dataset: {},
      getBoundingClientRect: (): DOMRect => ({
        x: 0, y: top, top, bottom: top + height, left: 0, right: 400, width: 400, height,
        toJSON: () => ({ top, height }),
      }),
    } as HTMLElement;
    Object.setPrototypeOf(element, LayoutElement.prototype);
    Object.defineProperty(element, "children", { value: children });
    styles.set(element, { display, position });
    return element;
  };
  const viewport = box(0, 600);
  Object.defineProperty(viewport, "clientHeight", { value: 600 });
  return { box, viewport };
}

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

test("a measured placeholder remains the anchor instead of its skipped descendants", t => {
  const { box, viewport } = layoutFixture(t);
  const placeholder = box(250, 100, [box(0, 0)]);
  placeholder.dataset.threadMeasuredContent = "placeholder";
  assert.equal(pickThreadReadingAnchor(viewport, box(0, 600, [placeholder])), placeholder);
});
