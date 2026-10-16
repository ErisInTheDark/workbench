/*
 * No production exports. Protect segment source ranges, partial moves, path splitting, extraction, circlify and rounded-corner resizing.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { getSvgShape } from "./svg-geometry";
import { parseSvgPathData } from "./svg-path-data";
import {
  circlifySvgSegments, deleteSvgSegments, extractSvgSegmentsPath, getSvgSegments, moveSvgSegments,
} from "./svg-segments";
import { parseSvgSource } from "./svg-source";

function only(markup: string) {
  const text = `<svg>${markup}</svg>`;
  const document = parseSvgSource(text);
  assert.ok(document.ok);
  return { text, element: document.elements[1]! };
}

test("segment ranges slice back to their own source text for relative, implicit, H/V, arc and polyline forms", () => {
  const path = only(`<path d="M8 14s1.5 2 4 2 4-2 4-2M3 3h2v1a1 1 0 011 1z"/>`);
  assert.deepEqual(getSvgSegments(path.element).map(segment => path.text.slice(segment.range!.start, segment.range!.end)),
    ["s1.5 2 4 2", "4-2 4-2", "h2", "v1", "a1 1 0 011 1", "z"]);
  const polyline = only(`<polyline points="1,1 2 2, 3,3"/>`);
  assert.deepEqual(getSvgSegments(polyline.element).map(segment => polyline.text.slice(segment.range!.start, segment.range!.end)),
    ["1,1 2 2", "2 2, 3,3"]);
  assert.equal(getSvgSegments(only(`<path d="M1 1&#x4C;2 2"/>`).element)[0]?.range, null);
});

test("moving some path segments moves only their own anchors and controls", () => {
  const { element } = only(`<path d="M0 0L4 0L4 4L0 4"/>`);
  const [edit] = moveSvgSegments(element, new Set([2]), { x: 1, y: 0 });
  assert.equal(edit?.value, "M0 0L5 0L5 4L0 4");
});

test("deleting a middle segment splits the path; deleting every segment removes the element", () => {
  const { text, element } = only(`<path d="M0 0L4 0L4 4L0 4Z"/>`);
  assert.equal(deleteSvgSegments(text, element, new Set([2])), `<svg><path d="M0 0L4 0M4 4L0 4L0 0"/></svg>`);
  assert.equal(deleteSvgSegments(text, element, new Set([1, 2, 3, 4])), "<svg></svg>");
  const rect = only(`<polyline points="0,0 4,0 4,4" stroke="red"/>`);
  assert.equal(deleteSvgSegments(rect.text, rect.element, new Set([0])), `<svg><path d="M4 0L4 4" stroke="red" /></svg>`);
});

test("extracting joins consecutive segments into one subpath and starts new ones at gaps", () => {
  const { element } = only(`<path d="M0 0L1 0L2 0L3 0"/>`);
  assert.equal(extractSvgSegmentsPath(element, new Set([1, 2])), "M0 0L1 0L2 0");
  assert.equal(extractSvgSegmentsPath(element, new Set([1, 3])), "M0 0L1 0M2 0L3 0");
});

test("circlify replaces every arc of a selected circle with one circle element", () => {
  const { text, element } = only(`<path d="M2 12a10 10 0 0 1 20 0a10 10 0 0 1 -20 0"/>`);
  assert.equal(circlifySvgSegments(text, element, new Set([1])), `<svg>\n<circle cx="12" cy="12" r="10" /></svg>`);
});

test("dragging a rounded corner's centre resizes it on the half grid while staying tangent to both lines", () => {
  const { element } = only(`<path d="M2 12V4a2 2 0 0 1 2-2h8"/>`);
  const shape = getSvgShape(element)!;
  assert.ok(shape.handles.some(handle => handle.id === "r2"));
  const resized = parseSvgPathData(shape.move("r2", { x: 5.1, y: 5.1 })[0]!.value)!;
  assert.deepEqual(resized[1]!.points.at(-1), { x: 2, y: 5 });
  assert.deepEqual(resized[2]!.arc?.slice(0, 2), [3, 3]);
  assert.deepEqual(resized[2]!.points.at(-1), { x: 5, y: 2 });
  assert.deepEqual(resized[3]!.points.at(-1), { x: 12, y: 2 });
});
