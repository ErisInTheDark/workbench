/*
 * No exports. Wards for link destinations: typed hrefs read back unchanged from the markdown they save as, scripts never
 * become links, and opening an href resolves beside its document without leaving the folder.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseInlineMarkdown } from "./markdown-parse";
import { headingSlug, resolveLinkTarget, toLinkDestination } from "./markdown-link-destination";

function hrefAfterRoundTrip(destination: string) {
  const [node] = parseInlineMarkdown(`[label](${destination})`);
  return node?.type === "link" ? node.href : null;
}

test("typed hrefs read back unchanged from the markdown link they save as", () => {
  for (const input of [
    "https://en.wikipedia.org/wiki/Fox_(disambiguation)",
    "docs/my notes.md",
    "  https://example.com/a?b=c#d  ",
    "C:\\Users\\x\\file.md",
    "<https://wrapped.example>",
  ]) {
    const destination = toLinkDestination(input);
    assert.ok(destination, input);
    assert.equal(hrefAfterRoundTrip(destination), destination, input);
  }
});

test("bare web and mail addresses gain their scheme, and scripts are refused", () => {
  assert.equal(toLinkDestination("www.example.com"), "https://www.example.com");
  assert.equal(toLinkDestination("fox@example.com"), "mailto:fox@example.com");
  assert.equal(toLinkDestination("docs/basic.md"), "docs/basic.md");
  assert.equal(toLinkDestination("javascript:alert(1)"), null);
  assert.equal(toLinkDestination(" java\u0000script:alert(1)"), null);
  assert.equal(toLinkDestination("data:text/html,hi"), null);
  assert.equal(toLinkDestination("   "), null);
});

test("opening resolves files beside the document and inside its folder", () => {
  assert.deepEqual(resolveLinkTarget("docs/basic.md", "README.md"), { kind: "file", path: "docs/basic.md" });
  assert.deepEqual(resolveLinkTarget("../ts.md#setup", "docs/rules/README.md"), { kind: "file", path: "docs/ts.md" });
  assert.deepEqual(resolveLinkTarget("/editors/vscode", "docs/basic.md"), { kind: "file", path: "editors/vscode" });
  assert.deepEqual(resolveLinkTarget("my%20notes.md", "docs/a.md"), { kind: "file", path: "docs/my notes.md" });
  assert.equal(resolveLinkTarget("../outside.md", "README.md"), null);
  assert.equal(resolveLinkTarget("C:/elsewhere/file.md", "README.md"), null);
});

test("opening sends web addresses to the browser and anchors to headings", () => {
  assert.deepEqual(resolveLinkTarget("https://example.com/x", "README.md"), { kind: "web", url: "https://example.com/x" });
  assert.deepEqual(resolveLinkTarget("mailto:fox@example.com", "README.md"), { kind: "web", url: "mailto:fox@example.com" });
  assert.deepEqual(resolveLinkTarget("//cdn.example.com", "README.md"), { kind: "web", url: "https://cdn.example.com" });
  assert.deepEqual(resolveLinkTarget("#the-language", "README.md"), { kind: "heading", slug: "the-language" });
  assert.equal(resolveLinkTarget("javascript:alert(1)", "README.md"), null);
  assert.equal(headingSlug("  The Language: `.dx` rules! "), "the-language-dx-rules");
});
