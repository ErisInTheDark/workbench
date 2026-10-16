/*
 * No production exports. Protect source ranges the editor splices into, structural error reporting and caret lookup.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { findSvgElementAt, parseSvgSource } from "./svg-source";
import { applySvgAttributeEdits, duplicateSvgElement, formatSvgSource, removeSvgElement } from "./svg-source-edits";

const icon = `<?xml version="1.0"?>
<!-- lucide -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <g id='group'>
    <circle cx="12" cy="12" r="10"/>
    <path d="M8 12h8" stroke="a&amp;b" />
  </g>
  <style><![CDATA[ circle { fill: none } ]]></style>
</svg>
`;

function parsed(text: string) {
  const document = parseSvgSource(text);
  assert.ok(document.ok, document.ok ? "" : document.error.message);
  return document;
}

test("elements carry document-order indexes, decoded values and exact source ranges", () => {
  const document = parsed(icon);
  assert.deepEqual(document.elements.map(element => element.name), ["svg", "g", "circle", "path", "style"]);
  const path = document.elements[3]!;
  assert.equal(icon.slice(path.start, path.end), `<path d="M8 12h8" stroke="a&amp;b" />`);
  assert.equal(path.attributes[1]?.value, "a&b");
  assert.equal(path.parentIndex, 1);
  assert.equal(findSvgElementAt(document.elements, icon.indexOf("r=\"10\"")), document.elements[2]);
  assert.equal(findSvgElementAt(document.elements, icon.indexOf("<g") - 1), document.elements[0]);
});

test("structural errors report their line and column while still tokenising the rest", () => {
  const broken = `<svg>\n  <path d="M0 0">\n</svg>`;
  const document = parseSvgSource(broken);
  assert.equal(document.ok, false);
  assert.ok(!document.ok && document.error.line === 3 && /<\/path>/u.test(document.error.message));
  assert.ok(document.tokens.some(token => token.kind === "tag" && broken.slice(token.start, token.end) === "svg"));
  assert.equal(parseSvgSource(`<svg><g></svg>`).ok, false);
  assert.equal(parseSvgSource(`<div></div>`).ok, false);
  assert.equal(parseSvgSource(`<svg/><svg/>`).ok, false);
});

test("attribute edits rewrite only the edited values and append missing attributes", () => {
  const document = parsed(icon);
  const circle = document.elements[2]!;
  const next = applySvgAttributeEdits(icon, circle, [{ name: "cx", value: "6.5" }, { name: "fill", value: "\"x\"" }]);
  assert.equal(next, icon.replace(`<circle cx="12" cy="12" r="10"/>`, `<circle cx="6.5" cy="12" r="10" fill="&quot;x&quot;"/>`));
  const group = document.elements[1]!;
  assert.equal(applySvgAttributeEdits(icon, group, [{ name: "id", value: "it's" }]), icon.replace("id='group'", "id='it&apos;s'"));
});

test("removing and duplicating keep line structure and duplicates land after the original", () => {
  const document = parsed(icon);
  const circle = document.elements[2]!;
  assert.equal(removeSvgElement(icon, circle), icon.replace(`    <circle cx="12" cy="12" r="10"/>\n`, ""));
  const duplicated = duplicateSvgElement(icon, circle).text;
  assert.equal(duplicated, icon.replace(`<circle cx="12" cy="12" r="10"/>`, `<circle cx="12" cy="12" r="10"/>\n    <circle cx="12" cy="12" r="10"/>`));
  assert.equal(parsed(duplicated).elements[3]?.name, "circle");
});

test("formatting re-indents without changing raw values, text or comments, and is stable", () => {
  const messy = `<svg viewBox="0 0 24 24"><g><path d="M1  1L2 2"/></g><text x="1">a &amp; b</text><!-- note --></svg>`;
  const formatted = formatSvgSource(messy);
  assert.equal(formatted, [
    `<svg viewBox="0 0 24 24">`,
    `  <g>`,
    `    <path d="M1  1L2 2" />`,
    `  </g>`,
    `  <text x="1">a &amp; b</text>`,
    `  <!-- note -->`,
    `</svg>`,
    ``,
  ].join("\n"));
  assert.equal(formatSvgSource(formatted!), formatted);
  assert.equal(formatSvgSource(`<svg>`), null);
});
