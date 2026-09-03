/*
 * No production exports. Regression wards protect ordered-list ordinals, agent-authored inline markers, notice blocks, Markdown bodies, and literal fallback. Keywords: thread, markdown, list, icon, notice, color.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { renderThreadMarkdown } from "./thread-markdown-render";

test("ordered lists render every source ordinal literally", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    "7. alpha",
    "7. beta",
    "42) gamma",
  ].join("\n"))));
  const ordinals = Array.from(html.matchAll(/<li[^>]*\svalue="(\d+)"[^>]*>/gu), (match) => match[1]);

  assert.deepEqual(ordinals, ["7", "7", "42"]);
});

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

test("thread notices render compact and two-paragraph Markdown bodies", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<notice title="Breaking change" color="red">Update **every caller** before merging.</notice>',
    "",
    '<notice title="Decision needed" color="purple">',
    "The current owner cannot enforce this rule.",
    "",
    "Choose the [new owner](https://example.com/owner) before implementation.",
    "</notice>",
  ].join("\n"))));

  assert.equal(Array.from(html.matchAll(/data-thread-notice="true"/gu)).length, 2);
  assert.equal(Array.from(html.matchAll(/data-thread-notice-icon="alert"/gu)).length, 2);
  assert.match(html, /aria-label="Breaking change"/u);
  assert.match(html, /data-thread-notice-color="red"/u);
  assert.match(html, /Update <strong>every caller<\/strong> before merging\./u);
  assert.match(html, /aria-label="Decision needed"/u);
  assert.match(html, /data-thread-notice-color="purple"/u);
  assert.match(html, /The current owner cannot enforce this rule\.<\/p><p[^>]*>Choose the /u);
  assert.match(html, /href="https:\/\/example\.com\/owner"/u);
});

test("thread notices accept body text beside multiline delimiters", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<notice title="Mixed delimiters" color="yellow">Opening-line **body**.',
    "",
    "Closing-line `body`.</notice>",
  ].join("\n"))));

  assert.equal(Array.from(html.matchAll(/data-thread-notice="true"/gu)).length, 1);
  assert.match(html, /aria-label="Mixed delimiters"/u);
  assert.match(html, /data-thread-notice-color="yellow"/u);
  assert.match(html, /Opening-line <strong>body<\/strong>\.<\/p><p[^>]*>Closing-line <code[^>]*>body<\/code>\./u);
  assert.doesNotMatch(html, /&lt;\/?notice/u);
});

test("thread notices render inside plans without closing on fenced source", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    "<plan>",
    '<notice title="Parser safety" color="yellow">',
    "```md",
    "</notice>",
    "```",
    "Still inside the notice.",
    "</notice>",
    "</plan>",
  ].join("\n"))));

  assert.equal(Array.from(html.matchAll(/data-thread-notice="true"/gu)).length, 1);
  assert.match(html, /data-thread-notice-color="yellow"/u);
  assert.match(html, /data-thread-codeblock="true"/u);
  assert.match(html, /&lt;\/notice&gt;/u);
  assert.match(html, /Still inside the notice\./u);
});

test("unsupported, empty, unclosed, and code-contained notices remain literal text", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<notice title="Unsupported" color="orange">body</notice>',
    "",
    '<notice title="" color="red">body</notice>',
    "",
    '<notice title="Unclosed" color="blue">',
    "body",
    "",
    '`<notice title="Code span" color="green">body</notice>`',
    "",
    "```md",
    '<notice title="Source" color="green">body</notice>',
    "```",
  ].join("\n"))));

  assert.doesNotMatch(html, /data-thread-notice=/u);
  assert.doesNotMatch(html, /data-thread-notice-icon=/u);
  assert.match(html, /&lt;notice title=&quot;Unsupported&quot; color=&quot;orange&quot;&gt;\s*body\s*&lt;\/notice&gt;/u);
  assert.match(html, /&lt;notice title=&quot;&quot; color=&quot;red&quot;&gt;\s*body\s*&lt;\/notice&gt;/u);
  assert.match(html, /&lt;notice title=&quot;Unclosed&quot; color=&quot;blue&quot;&gt;/u);
  assert.match(html, /<code[^>]*>&lt;notice title=&quot;Code span&quot; color=&quot;green&quot;&gt;body&lt;\/notice&gt;<\/code>/u);
  assert.match(html, /&lt;notice title=&quot;Source&quot; color=&quot;green&quot;&gt;body&lt;\/notice&gt;/u);
});

test("append presentation isolates the semantic suffix without duplicating text", () => {
  const textAppend = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    "Hello world",
    {},
    {
      blockIndex: 0,
      kind: "text",
      nodePath: [0],
      prefixLength: 5,
      revisionKey: "5:11",
    },
  )));
  const formattedAppend = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    "Hello **world**",
    {},
    {
      blockIndex: 0,
      kind: "inlineTail",
      revisionKey: "5:15",
      startNodeIndex: 1,
    },
  )));

  assert.match(textAppend, /Hello<span[^>]+data-thread-markdown-append-reveal="true"[^>]*> world<\/span>/u);
  assert.equal(textAppend.replace(/<[^>]+>/gu, ""), "Hello world");
  assert.match(formattedAppend, /Hello <span[^>]+data-thread-markdown-append-reveal="true"[^>]*><strong>world<\/strong><\/span>/u);
  assert.equal(formattedAppend.replace(/<[^>]+>/gu, ""), "Hello world");
});
