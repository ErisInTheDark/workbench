/*
 * No production exports. Protect point editing: relative path data keeps untouched points in place and attached controls follow anchors.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { getSvgShape } from "./svg-geometry";
import { parseSvgPathData, serializeSvgPathData } from "./svg-path-data";
import { parseSvgSource } from "./svg-source";

function element(markup: string) {
  const document = parseSvgSource(`<svg>${markup}</svg>`);
  assert.ok(document.ok);
  return document.elements[1]!;
}

function anchors(d: string) {
  return parseSvgPathData(d)!.filter(segment => segment.type !== "Z").map(segment => segment.points.at(-1)!);
}

test("path data parses implicit, relative, compact-arc and closed forms into absolute points", () => {
  assert.deepEqual(anchors("m2 2 3 0h1v4a1 1 0 011 1z"), [
    { x: 2, y: 2 }, { x: 5, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 7, y: 7 },
  ]);
  assert.equal(parseSvgPathData("M1 1L2"), null);
  assert.equal(serializeSvgPathData(parseSvgPathData("M1 1l2 2Z")!), "M1 1l2 2Z");
});

test("moving a relative anchor keeps every later point at its absolute position", () => {
  const path = element(`<path d="M2 2l4 0l0 4h-4z"/>`);
  const shape = getSvgShape(path)!;
  const [edit] = shape.move("1:0", { x: 7, y: 3 });
  assert.equal(edit?.name, "d");
  assert.deepEqual(anchors(edit!.value), [{ x: 2, y: 2 }, { x: 7, y: 3 }, { x: 6, y: 6 }, { x: 2, y: 6 }]);
});

test("anchors drag their attached curve controls; controls move alone", () => {
  const shape = getSvgShape(element(`<path d="M0 0C1 0 2 1 3 3C4 5 5 6 6 6"/>`))!;
  const moved = parseSvgPathData(shape.move("1:2", { x: 4, y: 4 })[0]!.value)!;
  assert.deepEqual(moved[1]!.points, [{ x: 1, y: 0 }, { x: 3, y: 2 }, { x: 4, y: 4 }]);
  assert.deepEqual(moved[2]!.points, [{ x: 5, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 }]);
  const control = parseSvgPathData(shape.move("1:0", { x: 0, y: 2 })[0]!.value)!;
  assert.deepEqual(control[1]!.points, [{ x: 0, y: 2 }, { x: 2, y: 1 }, { x: 3, y: 3 }]);
});

test("primitive shapes write their own attributes and refuse values they cannot place", () => {
  assert.deepEqual(getSvgShape(element(`<circle cx="12" cy="12" r="4"/>`))!.move("r", { x: 12, y: 18 }), [{ name: "r", value: "6" }]);
  assert.deepEqual(getSvgShape(element(`<rect x="2" y="2" width="4" height="4"/>`))!.move("tl", { x: 3, y: 1 }),
    [{ name: "x", value: "3" }, { name: "y", value: "1" }, { name: "width", value: "3" }, { name: "height", value: "5" }]);
  assert.deepEqual(getSvgShape(element(`<polyline points="1,1 2 2"/>`))!.translate({ x: 0.5, y: -1 }),
    [{ name: "points", value: "1.5,0 2.5,1" }]);
  assert.equal(getSvgShape(element(`<rect x="10%" y="0" width="1" height="1"/>`)), null);
  assert.equal(getSvgShape(element(`<g/>`)), null);
});
