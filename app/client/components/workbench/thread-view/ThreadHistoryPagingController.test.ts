/*
 * Exports:
 * - No production exports; Node tests protect paced paging, one page in flight until rendered, and post-retention suppression.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadHistoryPagingController, { type HistoryPagingView } from "./ThreadHistoryPagingController";

function fixture() {
  let now = 0;
  const scheduled = new Set<{ at: number; callback: () => void }>();
  let boundaryKey: string | null = "page-2";
  let sourceReady = true;
  let renderedTurnIds = ["turn-2"];
  let requestStatus: HistoryPagingView["requestStatus"];
  let nearTop = true;
  let identity = {};
  const viewport = {};
  let loads = 0;
  let transaction: number | null = null;
  const controller = new ThreadHistoryPagingController({
    readView: () => ({ identity, viewport, boundaryKey, sourceReady, renderedTurnIds, requestStatus, nearTop }),
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
    controller,
    get loads() { return loads; },
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
    render() {
      sourceReady = true;
      renderedTurnIds = ["turn-1", "turn-2"];
      controller.reconcile();
    },
    setNearTop(value: boolean) { nearTop = value; controller.reconcile(); },
    setSourceReady(value: boolean) { sourceReady = value; controller.reconcile(); },
    move(historyIntent = false) { controller.interrupt({ historyIntent }); },
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
  f.move(true);
  f.advance(499);
  assert.equal(f.loads, 0);
  f.advance(1);
  assert.equal(f.loads, 1);
});

test("sql receipt does not admit another page before the received page renders", () => {
  const f = fixture();
  f.start();
  f.receive();
  f.advance(2_000);
  assert.equal(f.loads, 1);
  f.setSourceReady(true);
  f.advance(2_000);
  assert.equal(f.loads, 1, "ready with the old turn set is not the new rendered page");
  f.render();
  assert.equal(f.loads, 1);
  f.advance(499);
  assert.equal(f.loads, 1);
  f.advance(1);
  assert.equal(f.loads, 2);
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

test("replacement and disposal cancel old scheduled work", () => {
  const f = fixture();
  f.controller.reconcile();
  f.advance(250);
  f.replace();
  f.advance(250);
  assert.equal(f.loads, 0);
  f.controller.dispose();
  f.advance(5_000);
  assert.equal(f.loads, 0);
});
