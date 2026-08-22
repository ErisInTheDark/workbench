/*
 * No production exports. Regression wards protect agent-authored inline marker rendering and literal fallback. Keywords: thread, markdown, icon, alert, color.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { renderThreadMarkdown } from "./thread-markdown-render";

test("thread alert markers render every supported semantic color", () => {
  const colorClassNames = {
    blue: ["text-sky-600", "dark:text-sky-300"],
    green: ["text-emerald-600", "dark:text-emerald-300"],
    purple: ["text-violet-600", "dark:text-violet-300"],
    red: ["text-red-600", "dark:text-red-300"],
    yellow: ["text-amber-600", "dark:text-amber-300"],
  } as const;
  const markdown = Object.keys(colorClassNames)
    .map((color) => `<icon color="${color}" type="alert" /> ${color}`)
    .join("\n\n");
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(markdown)));

  for (const [color, classNames] of Object.entries(colorClassNames)) {
    const markerTag = new RegExp(`<span[^>]*data-thread-inline-icon-color="${color}"[^>]*>`, "u").exec(html)?.[0];
    assert.ok(markerTag, `expected one ${color} alert marker`);
    assert.ok(markerTag.includes(`aria-label="${color} alert marker"`));
    for (const className of classNames) {
      assert.ok(markerTag.includes(className), `expected ${color} marker to include ${className}`);
    }
  }

  assert.equal(Array.from(html.matchAll(/data-thread-inline-icon="alert"/gu)).length, 5);
});

test("thread alert markers preserve the legacy type-first attribute order", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    '<icon type="alert" color="blue" /> legacy order',
  )));

  assert.match(html, /data-thread-inline-icon="alert"/u);
  assert.match(html, /data-thread-inline-icon-color="blue"/u);
});

test("unsupported and code-span markers remain literal text", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<icon color="red" type="red" /> unsupported type',
    '<icon color="orange" type="alert" /> unsupported color',
    '`<icon color="blue" type="alert" />` code span',
  ].join("\n\n"))));

  assert.match(html, /&lt;icon color=&quot;red&quot; type=&quot;red&quot; \/&gt; unsupported type/u);
  assert.match(html, /&lt;icon color=&quot;orange&quot; type=&quot;alert&quot; \/&gt; unsupported color/u);
  assert.match(html, /<code[^>]*>&lt;icon color=&quot;blue&quot; type=&quot;alert&quot; \/&gt;<\/code> code span/u);
  assert.doesNotMatch(html, /data-thread-inline-icon=/u);
});
