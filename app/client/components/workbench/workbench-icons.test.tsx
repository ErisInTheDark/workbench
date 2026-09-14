/* No production exports. Tests protect shared icon dimensions, stroke scaling, brand preservation, and compatibility modules. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ChevronIcon from "./ChevronIcon";
import GitArcIcon, { GitArcConflictIcon } from "./thread-view/GitArcIcon";
import {
  AppWindowIcon,
  BotIcon,
  CompactIcon,
  HarnessIcon,
  SaveIcon,
  SparkleIcon,
} from "./workbench-icons";

function render<Props extends object>(component: ComponentType<Props>, props: Props) {
  return renderToStaticMarkup(createElement(component, props));
}

function readNumericSvgAttribute(markup: string, name: string) {
  const match = markup.match(new RegExp(`\\s${name}="([^"]+)"`, "u"));
  assert.ok(match, `Expected ${name} in rendered SVG`);
  return Number(match[1]);
}

test("shared icon size controls dimensions while preserving visible stroke thickness", () => {
  const sizes = [12, 16, 20, 32] as const;
  const thicknesses = sizes.map((size) => {
    const markup = render(BotIcon, { size });
    const width = readNumericSvgAttribute(markup, "width");
    const height = readNumericSvgAttribute(markup, "height");
    const strokeWidth = readNumericSvgAttribute(markup, "stroke-width");

    assert.equal(width, size);
    assert.equal(height, size);
    return width * strokeWidth / 24;
  });

  for (const thickness of thicknesses) {
    assert.ok(Math.abs(thickness - thicknesses[0]) < Number.EPSILON);
  }
});

test("custom and layered icons use the shared frame", () => {
  const sparkle = render(SparkleIcon, { size: 14 });
  const compact = render(CompactIcon, { size: 18 });
  const save = render(SaveIcon, { size: 20 });

  assert.match(sparkle, /viewBox="0 0 24 24"/u);
  assert.match(sparkle, /width="14"/u);
  assert.match(sparkle, /stroke-width="/u);
  assert.match(compact, /width="18"/u);
  assert.match(compact, /stroke-width="/u);
  assert.match(save, /save-icon-main/u);
  assert.match(save, /save-icon-slash/u);
});

test("brand icons keep fill artwork without gaining an outline stroke", () => {
  const brand = render(HarnessIcon, { harness: "copilot", size: 20 });

  assert.match(brand, /width="20"/u);
  assert.match(brand, /height="20"/u);
  assert.doesNotMatch(brand, /stroke-width=/u);
});

test("compatibility modules render central sized icons", () => {
  assert.match(render(ChevronIcon, { size: 14 }), /width="14"/u);
  assert.match(render(GitArcConflictIcon, { size: 16 }), /width="16"/u);
  assert.match(render(GitArcIcon, { action: "propose", size: 18 }), /width="18"/u);
  assert.doesNotMatch(render(GitArcIcon, { action: "restore", size: 20 }), /vector-effect=/u);
  assert.match(render(AppWindowIcon, { size: 16 }), /width="16"/u);
});
