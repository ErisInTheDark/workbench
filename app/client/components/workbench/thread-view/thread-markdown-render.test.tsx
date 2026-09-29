/*
 * No production exports. Regression wards protect ordered-list ordinals, SVG preview laziness, agent-authored inline markers, notice blocks, Markdown bodies, and literal fallback.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { renderThreadInlineMarkdown, renderThreadMarkdown } from "./thread-markdown-render";

test("SVG source mode does not load a hidden preview document", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    "```svg",
    '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>',
    "```",
  ].join("\n"))));

  assert.match(html, /aria-label="Preview SVG code block"/u);
  assert.doesNotMatch(html, /<iframe\b/u);
});

test("ordered lists render every source ordinal literally", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    "7. alpha",
    "7. beta",
    "42) gamma",
  ].join("\n"))));
  const ordinals = Array.from(html.matchAll(/<li[^>]*\svalue="(\d+)"[^>]*>/gu), (match) => match[1]);

  assert.deepEqual(ordinals, ["7", "7", "42"]);
});

test("consecutive file links collapse across punctuation and whitespace without swallowing prose", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    "#[a.ts], #[b.ts];\n#[c.ts] explain #[d.ts]",
    { projectFilePaths: ["a.ts", "b.ts", "c.ts", "d.ts"], projectId: "project" },
  )));

  assert.match(html, /3 files/u);
  assert.doesNotMatch(html, /a\.ts.*b\.ts.*c\.ts/u);
  assert.match(html, /explain .*data-project-file-relative-path="d\.ts"/u);
});

test("a standalone and joins a file-link run but prose does not", () => {
  const options = { projectFilePaths: ["a.ts", "b.ts", "c.ts"], projectId: "project" };
  for (const separator of [" and ", ", and ", " and\n"]) {
    const joined = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
      `#[a.ts], #[b.ts]${separator}#[c.ts]`, options,
    )));
    assert.match(joined, /3 files/u);
    assert.doesNotMatch(joined, />and</u);
  }
  for (const prose of ["andrew ", "and and ", "and"]) {
    const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
      `#[a.ts] ${prose}#[b.ts]`, options,
    )));
    assert.doesNotMatch(html, /2 files/u);
  }
});

test("prose and formatting stop file-link grouping", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    "#[a.ts], note #[b.ts] **#[c.ts]**",
    { projectFilePaths: ["a.ts", "b.ts", "c.ts"], projectId: "project" },
  )));

  assert.doesNotMatch(html, /[23] files/u);
  assert.equal(Array.from(html.matchAll(/data-project-file-relative-path=/gu)).length, 3);
});

test("file grouping stays whole across an append boundary and outside thread mode stays unchanged", () => {
  const markdown = "#[a.ts], #[b.ts]";
  const options = { projectFilePaths: ["a.ts", "b.ts"], projectId: "project" };
  const appended = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    markdown, options, { blockIndex: 0, kind: "inlineTail", revisionKey: "append", startNodeIndex: 1 },
  )));
  const editorInline = renderToStaticMarkup(createElement(Fragment, null,
    renderThreadInlineMarkdown("[a.ts](a.ts), [b.ts](b.ts)", options, "editor-inline")));

  assert.match(appended, /2 files/u);
  assert.doesNotMatch(appended, /data-thread-markdown-append-reveal=/u);
  assert.doesNotMatch(editorInline, /2 files/u);
  assert.equal(Array.from(editorInline.matchAll(/data-project-file-relative-path=/gu)).length, 2);
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

test("thread check, asterisk, and x markers render inline icons", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<icon color="green" type="check" /> done',
    '<icon color="purple" type="asterisk" /> note',
    '<icon color="red" type="x" /> blocked',
  ].join("\n\n"))));

  for (const [type, color] of [["check", "green"], ["asterisk", "purple"], ["x", "red"]]) {
    assert.match(html, new RegExp(`<span[^>]*aria-label="${color} ${type} marker"[^>]*data-thread-inline-icon="${type}"[^>]*data-thread-inline-icon-color="${color}"[^>]*><svg\\b`, "u"));
  }
  assert.equal(Array.from(html.matchAll(/data-thread-inline-icon=/gu)).length, 3);
});

test("thread icons without color inherit surrounding text color", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    "**<icon type=\"alert\" /> <icon type=\"check\" /> <icon type=\"asterisk\" /> <icon type=\"x\" />**",
  )));

  for (const type of ["alert", "check", "asterisk", "x"]) {
    const markerTag = new RegExp(`<span[^>]*aria-label="${type} marker"[^>]*data-thread-inline-icon="${type}"[^>]*>`, "u").exec(html)?.[0];
    assert.ok(markerTag, `expected inherited ${type} marker`);
    assert.doesNotMatch(markerTag, /data-thread-inline-icon-color=|text-(?:sky|emerald|violet|red|amber)-/u);
  }
  assert.equal(Array.from(html.matchAll(/data-thread-inline-icon=/gu)).length, 4);
  assert.match(html, /<strong>.*data-thread-inline-icon="alert".*<\/strong>/u);
});

test("paired thread icons attach a markdown label in the chosen color", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    '<icon color="blue" type="asterisk">coloured **label** attached to icon</icon>',
  )));

  assert.match(html, /data-thread-inline-icon="asterisk"/u);
  assert.match(html, /data-thread-inline-icon-color="blue"/u);
  assert.match(html, /coloured <strong>label<\/strong> attached to icon/u);
  assert.doesNotMatch(html, /&lt;\/?icon/u);
});

test("paired icons inherit text color and malformed pairs stay literal", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<icon type="check">done</icon>',
    '<icon color="orange" type="check">unsupported color</icon>',
    '<icon type="x">unclosed',
  ].join("\n\n"))));

  assert.match(html, /data-thread-inline-icon="check"/u);
  assert.match(html, /data-thread-inline-icon="check"[^>]*>.*done/u);
  assert.match(html, /&lt;icon color=&quot;orange&quot; type=&quot;check&quot;&gt;unsupported color&lt;\/icon&gt;/u);
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

test("thread notices without a title render under a literal notice title", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<notice color="red">Update **every caller** before merging.</notice>',
    "",
    '<notice title="" color="purple">',
    "The current owner cannot enforce this rule.",
    "</notice>",
  ].join("\n"))));

  assert.equal(Array.from(html.matchAll(/data-thread-notice="true"/gu)).length, 2);
  assert.equal(Array.from(html.matchAll(/data-thread-notice-icon="alert"/gu)).length, 2);
  assert.equal(Array.from(html.matchAll(/aria-label="notice"/gu)).length, 2);
  assert.match(html, /data-thread-notice-color="red"/u);
  assert.match(html, /Update <strong>every caller<\/strong> before merging\./u);
  assert.match(html, /data-thread-notice-color="purple"/u);
  assert.match(html, /The current owner cannot enforce this rule\./u);
  assert.doesNotMatch(html, /&lt;notice/u);
});

test("thread notices accept the color-first attribute order", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<notice color="red" title="Breaking change">Update **every caller** before merging.</notice>',
    "",
    '<notice color="purple" title="Decision needed">',
    "The current owner cannot enforce this rule.",
    "</notice>",
  ].join("\n"))));

  assert.equal(Array.from(html.matchAll(/data-thread-notice="true"/gu)).length, 2);
  assert.match(html, /aria-label="Breaking change"/u);
  assert.match(html, /data-thread-notice-color="red"/u);
  assert.match(html, /Update <strong>every caller<\/strong> before merging\./u);
  assert.match(html, /aria-label="Decision needed"/u);
  assert.match(html, /data-thread-notice-color="purple"/u);
  assert.doesNotMatch(html, /&lt;notice/u);
});

test('thread notices accept quotes inside title attributes', () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<notice color="red" title="Breaking "API" change">Update **every caller** before merging.</notice>',
    "",
    '<notice title="Decision "required" now" color="purple">',
    "The current owner cannot enforce this rule.",
    "</notice>",
  ].join("\n"))));

  assert.equal(Array.from(html.matchAll(/data-thread-notice="true"/gu)).length, 2);
  assert.match(html, /aria-label="Breaking &quot;API&quot; change"/u);
  assert.match(html, /data-thread-notice-color="red"/u);
  assert.match(html, /Update <strong>every caller<\/strong> before merging\./u);
  assert.match(html, /aria-label="Decision &quot;required&quot; now"/u);
  assert.match(html, /data-thread-notice-color="purple"/u);
  assert.doesNotMatch(html, /&lt;notice/u);
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

test("unsupported, unclosed, and code-contained notices remain literal text", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    '<notice title="Unsupported" color="orange">body</notice>',
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
  assert.match(html, /&lt;notice title=&quot;Unclosed&quot; color=&quot;blue&quot;&gt;/u);
  assert.match(html, /<code[^>]*>&lt;notice title=&quot;Code span&quot; color=&quot;green&quot;&gt;body&lt;\/notice&gt;<\/code>/u);
  assert.match(html, /&lt;notice title=&quot;Source&quot; color=&quot;green&quot;&gt;body&lt;\/notice&gt;/u);
});

test("thread disclosures render an interactive summary and nested markdown body", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    "<details open><summary>why **this** changed</summary>",
    "",
    "## reasons",
    "- [owner](https://example.com/owner)",
    "<details open><summary>more</summary>",
    "`nested` answer",
    "</details>",
    "</details>",
  ].join("\n"))));

  assert.equal(Array.from(html.matchAll(/<details\b/gu)).length, 2);
  assert.match(html, /<details[^>]*open=""/u);
  assert.match(html, /<summary[^>]*>.*why <strong>this<\/strong> changed/u);
  assert.match(html, /<h2[^>]*>reasons<\/h2>/u);
  assert.match(html, /href="https:\/\/example\.com\/owner"/u);
  assert.match(html, /<code[^>]*>nested<\/code> answer/u);
});

test("thread disclosures start closed unless marked open", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown(
    "<details><summary>context</summary>\n**hidden body**\n</details>",
  )));

  assert.match(html, /<details\b/u);
  assert.doesNotMatch(html, /<details[^>]*open=/u);
  assert.match(html, /<summary[^>]*>.*context/u);
  assert.doesNotMatch(html, /hidden body/u);
});

test("malformed and fenced disclosure tags render as escaped text", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, renderThreadMarkdown([
    "<details><summary>unfinished</summary>",
    "body",
    "",
    "```md",
    "<details><summary>example</summary></details>",
    "```",
  ].join("\n"))));

  assert.doesNotMatch(html, /<details\b/u);
  assert.match(html, /&lt;details&gt;/u);
  assert.match(html, /&lt;summary&gt;example&lt;\/summary&gt;/u);
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
