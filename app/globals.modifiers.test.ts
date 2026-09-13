/*
 * No production exports. Tests protect Tailwind modifier-only foreground-mix utilities.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { compile } from "tailwindcss";

test("modifier-only utilities compile opaque foreground mixes", async () => {
  const globalsCss = await readFile(new URL("globals.css", import.meta.url), "utf8");
  const compiler = await compile(`${globalsCss.replace(/^@import .+;$/gmu, "")}\n@tailwind utilities;`);

  const css = compiler.build([
    "text-fg/62",
    "border-fg/10",
    "fill-fg/54",
    "stroke-fg/[62.5]",
    "text-fg/muted",
    "bg-fg/muted",
    "text-fg/muted-soft",
    "hover:bg-fg/6",
    "text-fg",
    "text-fg/nope",
    "text-fg-value/62",
  ]);

  assert.match(css, /\.text-fg\\\/62[\s\S]*?color-mix\([\s\S]*?calc\(62 \* 1%\)/u);
  assert.match(css, /\.border-fg\\\/10[\s\S]*?color-mix\([\s\S]*?calc\(10 \* 1%\)/u);
  assert.match(css, /\.fill-fg\\\/54[\s\S]*?color-mix\([\s\S]*?calc\(54 \* 1%\)/u);
  assert.match(css, /\.stroke-fg\\\/\\\[62\\\.5\\\][\s\S]*?color-mix\([\s\S]*?calc\(62\.5 \* 1%\)/u);
  assert.match(css, /\.text-fg\\\/muted[\s\S]*?var\(--muted-strength\)/u);
  assert.match(css, /\.bg-fg\\\/muted[\s\S]*?var\(--muted-strength\)/u);
  assert.match(css, /\.text-fg\\\/muted-soft[\s\S]*?calc\(var\(--muted-strength\) \* 0\.6\)/u);
  assert.match(css, /\.hover\\:bg-fg\\\/6:hover[\s\S]*?color-mix\([\s\S]*?calc\(6 \* 1%\)/u);
  assert.match(css, /var\(--fg-bg, var\(--bg\)\)/u);
  assert.match(css, /:hover/u);
  assert.doesNotMatch(css, /nope|text-fg-value/u);
});
