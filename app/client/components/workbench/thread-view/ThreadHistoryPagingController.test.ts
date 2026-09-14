/*
 * Exports:
 * - No production exports; Node tests protect paced paging, prepend anchoring, and post-retention suppression.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadHistoryPagingController, { type HistoryPagingView } from "./ThreadHistoryPagingController";

function fixture() {
  let now = 0;
  const scheduled = new Set<{ at: number; callback: () => void }>();
  let contentTop = 0;
  let scrollTop = 0;
  let scrollHeight = 2_000;
  let boundaryKey: string | null = "page-2";
  let sourceReady = true;
  let renderedTurnIds = ["turn-2"];
  let requestStatus: HistoryPagingView["requestStatus"];
  let nearTop = true;
  let identity = {};
  const viewport = {};
  let loads = 0;
  let transaction: number | null = null;
  const writes: number[] = [];
  const controller = new ThreadHistoryPagingController({
    readView: () => ({
      identity, viewport, boundaryKey, sourceReady, renderedTurnIds, requestStatus, nearTop, scrollTop,
      anchor: { turnId: "turn-2", top: contentTop - scrollTop },
      anchorTop: () => contentTop - scrollTop,
    }),
    writeScrollTop: (value) => {
      writes.push(value);
      scrollTop = value;
    },
    load: () => {
      transaction = controller.begin();
      if (transaction !== null) {
        loads += 1;
        requestStatus = "loading";
      }
    },
    schedule: (callback, delay) => {
      const task = { at: now + delay, callback };
      scheduled.add(task);
      return () => { scheduled.delete(task); };
    },
  });
  return {
    controller, writes,
    get loads() { return loads; },
    get scrollTop() { return scrollTop; },
    advance(ms: number) {
      now += ms;
      for (const task of [...scheduled]) {
        if (task.at <= now && scheduled.delete(task)) task.callback();
      }
    },
    start() { controller.reconcile(); this.advance(500); },
    receive() {
      assert.notEqual(transaction, null);
      controller.succeed(transaction!, ["turn-1"]);
      boundaryKey = "page-1";
      requestStatus = undefined;
      sourceReady = false;
      controller.reconcile();
    },
    render(shift = 600) {
      contentTop += shift;
      scrollHeight += shift;
      sourceReady = true;
      renderedTurnIds = ["turn-1", "turn-2"];
      controller.reconcile();
    },
    setNearTop(value: boolean) { nearTop = value; controller.reconcile(); },
    setSourceReady(value: boolean) { sourceReady = value; controller.reconcile(); },
    setScrollTop(value: number) { scrollTop = value; },
    move(value: number, historyIntent = false) { controller.interrupt({ historyIntent }); scrollTop = value; },
    replace() { identity = {}; controller.reconcile(); },
    fail() {
      assert.notEqual(transaction, null);
      controller.fail(transaction!);
      requestStatus = "failed";
      controller.reconcile();
    },
    retry() {
      transaction = controller.begin();
      if (transaction !== null) { loads += 1; requestStatus = "loading"; }
    },
  };
}

test("automatic paging waits for a dwell and cancels when the reader leaves", () => {
  const f = fixture();
  f.controller.reconcile();
  assert.equal(f.loads, 0);
  f.advance(499);
  assert.equal(f.loads, 0);
  f.setNearTop(false);
  f.advance(1);
  assert.equal(f.loads, 0);
  f.setNearTop(true);
  f.advance(500);
  assert.equal(f.loads, 1);
  f.controller.reconcile();
  f.advance(2_000);
  assert.equal(f.loads, 1);
});

test("retention suppression blocks exposed-sentinel reload until upward history intent", () => {
  const f = fixture();
  f.controller.reconcile();
  f.controller.suppressUntilHistoryIntent();
  f.advance(5_000);
  assert.equal(f.loads, 0);
  f.move(0, true);
  f.advance(499);
  assert.equal(f.loads, 0);
  f.advance(1);
  assert.equal(f.loads, 1);
});

test("sql receipt does not consume the anchor or admit another page before rendering", () => {
  const f = fixture();
  f.start();
  f.receive();
  f.advance(2_000);
  assert.equal(f.loads, 1);
  assert.deepEqual(f.writes, []);
  f.setSourceReady(true);
  f.advance(2_000);
  assert.equal(f.loads, 1, "ready with the old turn set is not the new rendered page");
  f.render();
  assert.equal(f.scrollTop, 600);
  assert.equal(f.loads, 1);
  f.advance(499);
  assert.equal(f.loads, 1);
  f.advance(1);
  assert.equal(f.loads, 2);
});

test("normal layout preserves a nonzero reader offset across prepended history", () => {
  const f = fixture();
  f.setScrollTop(300);
  f.start();
  f.receive();
  f.render(400);
  assert.equal(f.scrollTop, 700);
});

test("user scrolling relinquishes the anchor without releasing the render fence", () => {
  const f = fixture();
  f.start();
  f.receive();
  f.move(90);
  f.setNearTop(false);
  f.advance(2_000);
  assert.equal(f.loads, 1);
  f.render();
  assert.equal(f.scrollTop, 90);
  assert.deepEqual(f.writes, []);
  f.advance(500);
  assert.equal(f.loads, 1);
});

test("failures stay manual and explicit retry does not wait for an automatic dwell", () => {
  const f = fixture();
  f.start();
  f.fail();
  f.advance(5_000);
  assert.equal(f.loads, 1);
  f.retry();
  assert.equal(f.loads, 2);
});

test("replacement and disposal cancel old scheduled work and anchors", () => {
  const f = fixture();
  f.controller.reconcile();
  f.advance(250);
  f.replace();
  f.advance(250);
  assert.equal(f.loads, 0);
  f.controller.dispose();
  f.advance(5_000);
  assert.equal(f.loads, 0);

  const g = fixture();
  g.start();
  g.receive();
  g.replace();
  g.render();
  assert.deepEqual(g.writes, []);
});
