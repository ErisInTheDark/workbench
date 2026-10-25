/*
 * No exports. Save-guard sweep over editor DOM: every supported inline/block combination, arriving as pasted DOM or as a
 * mid-edit block still holding the caret, must reach disk through the real save button without changing its words.
 * Documents whose blocks interact through root normalization must save the same while another block is edited.
 */
import assert from "node:assert/strict";
import test from "node:test";
import MountedFilePanel from "./testing/MountedFilePanel";
import { renderedWords } from "./testing/editor-text";
import { checkSavedWords, reportSweep, type SweepFailure } from "./testing/save-guard-sweep";

const MARKS: Record<string, (content: string) => string> = {
  strong: content => `<strong>${content}</strong>`,
  em: content => `<em>${content}</em>`,
  code: content => `<code>${content}</code>`,
  del: content => `<del>${content}</del>`,
  ins: content => `<ins>${content}</ins>`,
  link: content => `<a href="https://example.test/">${content}</a>`,
  mark: content => `<mark>${content}</mark>`,
  "mark tag": content => `<u data-mark="bad">${content}</u>`,
};

const BLOCKS: Record<string, (content: string) => string> = {
  paragraph: content => `<p>${content}</p>`,
  heading: content => `<h2>${content}</h2>`,
  quote: content => `<blockquote>${content}</blockquote>`,
  "list item": content => `<ul><li>${content}</li></ul>`,
  "nested list item": content => `<ul><li>top<ul><li>${content}</li></ul></li></ul>`,
};

const INNER = ["w", " w", "w ", " w "];
const BEFORE = ["", "a", "a ", "<em>a</em> "];
const AFTER = ["", "z", " z", " <strong>z</strong>"];

const LINE_STARTS = ["z", "- z", "# z", "> z", "1. z", "```z", "---", "&lt;del&gt;z&lt;/del&gt;", "&lt;!-- z --&gt;", "~~z~~", "&amp;nbsp;z"];
const BREAKS = ["<br>", "<br><br>", "<br><br><br>"];
const SPACES = ["a z", "a&nbsp;z", "a&nbsp;&nbsp;z", "&nbsp;a", "a&nbsp;", "a <strong>&nbsp;z</strong>", "a  <br>z"];

/** Runs of one mark, optionally wrapping another, inside every boundary-text combination. */
function inlineRuns(outer: string, inner: string | null = null) {
  const runs: string[] = [];
  for (const text of INNER) {
    const content = inner ? MARKS[outer]!(MARKS[inner]!(text)) : MARKS[outer]!(text);
    for (const before of BEFORE) for (const after of AFTER) runs.push(`${before}${content}${after}`);
  }
  return runs;
}

function softBrokenLines() {
  return [
    ...BREAKS.flatMap(lineBreak => ["a", "<strong>a</strong>"].flatMap(first => LINE_STARTS.map(line => `${first}${lineBreak}${line}`))),
    ...SPACES,
  ];
}

async function sweepPasted(contents: string[], block: (content: string) => string) {
  const panel = await MountedFilePanel.open("");
  const failures: SweepFailure[] = [];
  try {
    for (const content of contents) {
      const html = block(content);
      await panel.replaceHtml(html);
      await checkSavedWords(panel, html, renderedWords(html), failures);
    }
  } finally {
    panel.dispose();
  }
  assert.equal(failures.length, 0, reportSweep(failures, contents.length));
}

for (const [blockName, block] of Object.entries(BLOCKS)) {
  for (const mark of Object.keys(MARKS)) {
    test(`pasted ${mark} runs in a ${blockName} always save their words`, () => sweepPasted(inlineRuns(mark), block));
  }
  test(`soft-broken and spaced lines in a ${blockName} save their words`, () => sweepPasted(softBrokenLines(), block));
}

// Mark nesting is block-independent, so it is crossed exhaustively in paragraphs only.
for (const outer of Object.keys(MARKS)) {
  for (const inner of Object.keys(MARKS).filter(name => name !== outer)) {
    test(`pasted ${inner} inside ${outer} in a paragraph always saves its words`, () => sweepPasted(inlineRuns(outer, inner), BLOCKS.paragraph!));
  }
}

// Block-by-block inspection hands these to the whole document; the test environment checks both paths agree.
const INTERACTING_BLOCKS: Record<string, string> = {
  "lists split by an empty paragraph": "<ul><li>a</li></ul><p><br></p><ul><li>b</li></ul><p>tail</p>",
  "empty paragraphs at both edges": "<p><br></p><p>tail</p><p><br></p>",
  "an empty paragraph between blocks": "<p>head</p><p><br></p><p><br></p><p>tail</p>",
  "a comment group between blocks": "<p>head</p><span data-comment-thread=\"block\" data-comments=\"[{&quot;author&quot;:&quot;a&quot;,&quot;body&quot;:&quot;one&quot;}]\"></span><p>tail</p>",
};

for (const [name, html] of Object.entries(INTERACTING_BLOCKS)) {
  test(`${name} keep their words while another block is edited`, async () => {
    const panel = await MountedFilePanel.open("");
    try {
      await panel.replaceHtml(html);
      await panel.caret("tai|l");
      await panel.type("x");
      const saved = await panel.save();
      assert.match(saved, /taixl/u);
      assert.deepEqual(renderedWords(saved).filter(word => word !== "taixl"), renderedWords(html).filter(word => word !== "tail"));
    } finally {
      panel.dispose();
    }
  });
}

test("a long document saves each edit exactly as its blocks read", async () => {
  const markdown = "# title\n\nintro *with* `code`\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quoted\n\nlast line\n";
  const panel = await MountedFilePanel.open(markdown);
  try {
    await panel.caret("intro| ");
    await panel.type("duced");
    assert.equal(await panel.save(), markdown.replace("intro ", "introduced "));
    await panel.caret("last| line");
    await panel.type("ing");
    assert.equal(await panel.save(), markdown.replace("intro ", "introduced ").replace("last line", "lasting line"));
  } finally {
    panel.dispose();
  }
});

for (const mark of Object.keys(MARKS)) {
  test(`${mark} runs still holding the caret save their words`, async () => {
    const panel = await MountedFilePanel.open("");
    const failures: SweepFailure[] = [];
    const runs = inlineRuns(mark);
    try {
      for (const run of runs) {
        const html = `<p>${run}</p><p>other block</p>`;
        await panel.replaceHtml(html);
        const editing = panel.editor.querySelector("p")!;
        await panel.caretIn(editing, editing.childNodes.length);
        await panel.notifyInput();
        await checkSavedWords(panel, html, renderedWords(html), failures);
      }
    } finally {
      panel.dispose();
    }
    assert.equal(failures.length, 0, reportSweep(failures, runs.length));
  });
}
