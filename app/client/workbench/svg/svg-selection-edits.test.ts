/*
 * No production exports. Protect multi-element selection edits, cross-file clipboard markup, and icon-grid analysis.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSvgSegments, type SvgRootSegment } from "./svg-analysis";
import { insertSvgMarkup, svgSelectionMarkup } from "./svg-clipboard";
import { deleteSvgSelection, duplicateSvgSelection, moveSvgSelection, transformSvgSelection } from "./svg-selection-edits";
import { parseSvgSource } from "./svg-source";

const icon = `<svg viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="4" />
  <path d="M2 2L6 2L6 6" stroke="red" />
  <text x="1" y="20">hi</text>
</svg>
`;

function parsed(text: string) {
  const document = parseSvgSource(text);
  assert.ok(document.ok);
  return document;
}

test("moving a mixed selection translates whole shapes, moves partial path segments, and transforms text-less shapes", () => {
  const document = parsed(icon);
  const moved = moveSvgSelection(icon, document, new Map([[1, new Set([0])], [2, new Set([2])], [3, null]]), () => ({ x: 1, y: 1 }));
  assert.match(moved, /<circle cx="13" cy="13" r="4" \/>/u);
  assert.match(moved, /d="M2 2L7 3L7 7"/u);
  assert.match(moved, /<text x="2" y="21">hi<\/text>/u);
});

test("deleting and duplicating work across elements, and duplicates land at the end of the root", () => {
  const document = parsed(icon);
  assert.equal(parsed(deleteSvgSelection(icon, document, new Map([[1, null], [3, null]]))).elements.map(element => element.name).join(),
    "svg,path");
  const copied = duplicateSvgSelection(icon, document, new Map([[2, new Set([1])]]))!;
  const result = parsed(copied.text);
  assert.deepEqual(copied.indices, [4]);
  assert.equal(result.elements[4]?.attributes.find(attribute => attribute.name === "d")?.value, "M2 2L6 2");
  assert.equal(result.elements[4]?.attributes.find(attribute => attribute.name === "stroke")?.value, "red");
});

test("copied markup pastes into another file as top-level elements, wrapped or bare", () => {
  const source = parsed(icon);
  const markup = svgSelectionMarkup(icon, source, new Map([[1, null]]));
  const target = `<svg viewBox="0 0 24 24"/>`;
  const pasted = insertSvgMarkup(target, parsed(target), markup)!;
  assert.equal(pasted.text, `<svg viewBox="0 0 24 24">\n  <circle cx="12" cy="12" r="4" />\n</svg>`);
  const bare = insertSvgMarkup(pasted.text, parsed(pasted.text), `<line x1="0" y1="0" x2="1" y2="1"/>`)!;
  assert.deepEqual(parsed(bare.text).elements.map(element => element.name), ["svg", "circle", "line"]);
  assert.deepEqual(bare.indices, [2]);
});

test("flipping everything mirrors points around the canvas centre and flips arc sweep", () => {
  const text = `<svg viewBox="0 0 24 24"><path d="M2 2A2 2 0 0 1 4 4"/><rect x="1" y="1" width="2" height="4"/></svg>`;
  const flipped = transformSvgSelection(text, parsed(text), null, point => ({ x: 24 - point.x, y: point.y }), { mirrored: true, scale: 1 });
  assert.match(flipped, /d="M22 2A2 2 0 0 0 20 4"/u);
  assert.match(flipped, /<rect x="21" y="1" width="2" height="4"\/>/u);
});

function line(key: string, elementIndex: number, start: { x: number; y: number }, end: { x: number; y: number }, ends = true): SvgRootSegment {
  return {
    key, elementIndex, kind: "line", start, end, controls: [], circle: null, opensSubpath: ends, closesSubpath: ends,
    samples: Array.from({ length: 5 }, (_, step) => ({ x: start.x + (end.x - start.x) * step / 4, y: start.y + (end.y - start.y) * step / 4 })),
  };
}

test("analysis flags ends that stop just short of a whole circle", () => {
  const circle: SvgRootSegment = {
    key: "1:0", elementIndex: 1, kind: "shape", start: { x: 11, y: 12 }, end: { x: 11, y: 12 }, controls: [],
    circle: { x: 13, y: 12, r: 2, tangentIntersection: null }, opensSubpath: false, closesSubpath: false,
    samples: Array.from({ length: 41 }, (_, step) => ({ x: 13 + 2 * Math.cos(step * Math.PI / 20), y: 12 + 2 * Math.sin(step * Math.PI / 20) })),
  };
  const analysis = analyzeSvgSegments([circle, line("2:1", 2, { x: 15.4, y: 12 }, { x: 20, y: 12 })]);
  assert.equal(analysis.snaps.length, 1);
  assert.deepEqual(analysis.snaps[0]?.at, { x: 15.4, y: 12 });
  assert.ok(Math.abs(analysis.snaps[0]!.suggestion!.x - 15) < 1e-9);
});

test("analysis labels off-axis lines, flags near-miss endpoints with a snap suggestion, and groups separate glyph parts", () => {
  const analysis = analyzeSvgSegments([
    line("1:1", 1, { x: 2, y: 2 }, { x: 10, y: 6 }),
    line("2:1", 2, { x: 2, y: 12 }, { x: 22, y: 12 }, false),
    line("3:1", 3, { x: 12, y: 12.4 }, { x: 12, y: 20 }),
  ]);
  assert.deepEqual(analysis.angles.map(angle => angle.label), ["26.57°"]);
  assert.deepEqual(analysis.snaps, [{ at: { x: 12, y: 12.4 }, suggestion: { x: 12, y: 12 } }]);
  assert.deepEqual(analysis.gapGroups, [[1], [2, 3]]);
});
