/*
 * Tests:
 * - pointer threshold, boundary-gated proximity, scoped target delivery, geometry caching, final-coordinate drop, cancellation, and cleanup.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchDragController from "./WorkbenchDragController";
import { WORKBENCH_THREAD_ORDER_DROP_TARGET_ID } from "./workbench-drag";

test("the controller resolves extended targets inside the closest boundary and drops at final coordinates", () => {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const style: Record<string, string> = {
    cursor: "crosshair",
    overflow: "auto",
    overscrollBehavior: "contain",
    touchAction: "pan-y",
    userSelect: "text",
  };
  const boundary = { dataset: {}, getBoundingClientRect: () => ({ bottom: 1_000, left: 0, right: 100, top: 0 }) } as unknown as HTMLElement;
  const hit = { closest: () => boundary } as unknown as Element;
  let currentHit: Element | null = hit;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const values = listeners.get(type) ?? new Set(); values.add(listener); listeners.set(type, values);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => { listeners.get(type)?.delete(listener); },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: { style }, elementFromPoint: () => currentHit } });
  const dispatch = (type: string, x: number, y: number) => {
    const event = { clientX: x, clientY: y, preventDefault: () => undefined, stopPropagation: () => undefined } as unknown as PointerEvent;
    for (const listener of [...listeners.get(type) ?? []]) listener(event);
  };
  try {
    const controller = new WorkbenchDragController();
    const drops: string[] = [];
    let rectangleReads = 0;
    const target = (top: number, key: string) => ({
      boundary,
      dropTargetId: WORKBENCH_THREAD_ORDER_DROP_TARGET_ID,
      element: { getBoundingClientRect: () => {
        rectangleReads += 1;
        return { bottom: top + 1, left: 10, right: 90, top };
      } } as unknown as HTMLElement,
      onDrop: () => { drops.push(key); },
      range: { x: 24, y: 100_000 },
    });
    const first = controller.registerTarget(target(10, "first"));
    const second = controller.registerTarget(target(990, "second"));
    const firstSnapshots: Array<ReturnType<typeof first.getSnapshot>> = [];
    const secondSnapshots: Array<ReturnType<typeof second.getSnapshot>> = [];
    first.subscribe(() => { firstSnapshots.push(first.getSnapshot()); });
    second.subscribe(() => { secondSnapshots.push(second.getSnapshot()); });
    const idleActivity = controller.getActivitySnapshot();
    controller.begin({ button: 0, clientX: 0, clientY: 0 }, {
      dropTargetIds: [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID],
      label: "thread",
      payload: { section: "pinned", sourceKey: "codex:thread", target: { kind: "thread", target: { kind: "provider", threadId: "thread" } }, type: "thread-row" },
    });
    dispatch("pointermove", 3, 3);
    assert.equal(controller.getSnapshot().active, false);
    dispatch("pointermove", 50, 400);
    const activeActivity = controller.getActivitySnapshot();
    assert.deepEqual(style, {
      cursor: "grabbing",
      overflow: "auto",
      overscrollBehavior: "contain",
      touchAction: "pan-y",
      userSelect: "none",
    });
    assert.equal(controller.getSnapshot().selectedRegistrationId, first.registrationId);
    assert.deepEqual(firstSnapshots, [{ selected: true, x: 50, y: 400 }]);
    assert.deepEqual(secondSnapshots, []);
    assert.equal(rectangleReads, 2);
    dispatch("pointermove", 50, 600);
    assert.equal(controller.getSnapshot().selectedRegistrationId, second.registrationId);
    assert.deepEqual(firstSnapshots, [{ selected: true, x: 50, y: 400 }, { selected: false, x: 0, y: 0 }]);
    assert.deepEqual(secondSnapshots, [{ selected: true, x: 50, y: 600 }]);
    assert.equal(controller.getActivitySnapshot(), activeActivity);
    assert.equal(rectangleReads, 2);
    dispatch("scroll", 0, 0);
    dispatch("pointermove", 50, 600);
    assert.equal(rectangleReads, 4);
    assert.deepEqual(secondSnapshots.at(-1), { selected: true, x: 50, y: 600 });
    dispatch("pointerup", 50, 300);
    assert.deepEqual(drops, ["first"]);
    assert.equal(rectangleReads, 6);
    assert.equal(controller.getSnapshot().active, false);
    assert.equal(controller.getActivitySnapshot(), idleActivity);
    assert.deepEqual(style, {
      cursor: "crosshair",
      overflow: "auto",
      overscrollBehavior: "contain",
      touchAction: "pan-y",
      userSelect: "text",
    });
    currentHit = { closest: () => null } as unknown as Element;
    controller.begin({ button: 0, clientX: 0, clientY: 0 }, {
      dropTargetIds: [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID],
      label: "thread",
      payload: { section: "pinned", sourceKey: "codex:thread", target: { kind: "thread", target: { kind: "provider", threadId: "thread" } }, type: "thread-row" },
    });
    dispatch("pointermove", 50, 600);
    assert.equal(controller.getSnapshot().selectedRegistrationId, null);
    controller.cancel();
    first.unregister(); second.unregister(); controller.dispose();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("touch pointers cannot arm drag listeners or suppress their click", () => {
  const listeners: string[] = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (type: string) => { listeners.push(type); },
    removeEventListener: () => undefined,
  } });

  try {
    const controller = new WorkbenchDragController();
    const started = controller.begin({ button: 0, clientX: 12, clientY: 18, pointerType: "touch" }, {
      dropTargetIds: [WORKBENCH_THREAD_ORDER_DROP_TARGET_ID],
      label: "thread",
      payload: { section: "pinned", sourceKey: "codex:thread", target: { kind: "thread", target: { kind: "provider", threadId: "thread" } }, type: "thread-row" },
    });

    assert.equal(started, false);
    assert.deepEqual(listeners, []);
    assert.equal(controller.getSnapshot().active, false);
    controller.dispose();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});
