/*
 * No production exports. Tests protect mobile pane swipe eligibility, cancellation, and route return.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRoute, createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import MobilePaneSwipeController from "./MobilePaneSwipeController";

const thread = createThreadRoute("project", "thread");
const sidebar = createProjectRoute("project");

function start(controller: MobilePaneSwipeController, pane: "editor" | "explorer", x = 200,
  eligibleTarget = true) {
  return controller.start({
    browseProjectId: "project",
    eligibleTarget,
    pane,
    route: pane === "editor" ? thread : sidebar,
    viewportWidth: 400,
    touchId: 1,
    touchCount: 1,
    x,
    y: 300,
    timeMs: 0,
  });
}

function move(controller: MobilePaneSwipeController, x: number, y = 300, timeMs = 100,
  touchCount = 1) {
  return controller.move({ touchId: 1, touchCount, x, y, timeMs });
}

function finish(controller: MobilePaneSwipeController, x: number, y = 300, timeMs = 120) {
  return controller.finish({ touchId: 1, touchCount: 1, x, y, timeMs });
}

test("right from editor opens sidebar and left returns to the remembered editor", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(thread);
  assert.equal(start(controller, "editor"), true);
  move(controller, 330);
  assert.equal(finish(controller, 330)?.view, "project");
  controller.observeRoute(sidebar);
  start(controller, "explorer");
  move(controller, 70);
  assert.deepEqual(finish(controller, 70), thread);
});

test("a directly loaded sidebar has no invented editor destination", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(sidebar);
  assert.equal(start(controller, "explorer"), false);
});

test("the far forty percent is excluded on the opposite side of each pane", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(thread);
  assert.equal(start(controller, "editor", 300), false);
  controller.observeRoute(sidebar);
  assert.equal(start(controller, "explorer", 100), false);
  assert.equal(start(controller, "explorer", 200), true);
  move(controller, 70);
  assert.deepEqual(finish(controller, 70), thread);
});

test("input or horizontally scrollable starts cannot become pane navigation", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(thread);
  assert.equal(start(controller, "editor", 200, false), false);
  move(controller, 300);
  assert.equal(finish(controller, 300), null);
});

test("movement after a near-stationary dwell is cancelled, but an early swipe may finish later", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(thread);
  start(controller, "editor");
  move(controller, 204, 301, 200);
  move(controller, 330, 300, 500);
  assert.equal(finish(controller, 330, 300, 520), null);
  start(controller, "editor");
  move(controller, 212, 301, 100);
  move(controller, 330, 300, 500);
  assert.equal(finish(controller, 330, 300, 520)?.view, "project");
});

test("vertical-first, multi-touch, opposite-direction and route changes cancel a swipe", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(thread);
  start(controller, "editor");
  move(controller, 205, 340);
  assert.equal(finish(controller, 330, 340), null);
  start(controller, "editor");
  move(controller, 330, 300, 100, 2);
  assert.equal(finish(controller, 330), null);
  start(controller, "editor");
  move(controller, 110);
  assert.equal(finish(controller, 110), null);
  start(controller, "editor");
  move(controller, 330);
  controller.observeRoute(sidebar);
  assert.equal(finish(controller, 330), null);
});

test("finger-follow preview reverses before release and only final travel decides", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(thread);
  start(controller, "editor");
  assert.equal(move(controller, 210), 10);
  const far = move(controller, 390);
  const unswiped = move(controller, 240);
  assert.ok(typeof far === "number" && far > 0);
  assert.ok(typeof unswiped === "number" && unswiped < far);
  assert.equal(finish(controller, 240), null);
  start(controller, "editor");
  move(controller, 210);
  assert.equal(finish(controller, 330)?.view, "project");
});

test("preview is clamped to the pane span without changing the final release rule", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(thread);
  start(controller, "editor");
  move(controller, 210);
  assert.ok((move(controller, 1_000) ?? 0) <= 400);
  assert.equal(finish(controller, 240), null);
});

test("the final travel rule remains reachable at the edge of the allowed start zone", () => {
  const controller = new MobilePaneSwipeController();
  controller.observeRoute(thread);
  assert.equal(start(controller, "editor", 240), true);
  move(controller, 250);
  assert.equal(finish(controller, 339), null);
  assert.equal(start(controller, "editor", 240), true);
  move(controller, 250);
  assert.equal(finish(controller, 340)?.view, "project");
});
