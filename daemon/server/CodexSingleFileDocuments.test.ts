/* Exports: none. Protect retained session evidence, ordered writes and active-session pruning. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import CodexSingleFileDocuments from "./CodexSingleFileDocuments";

async function fixture(context: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-documents-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, owner: new CodexSingleFileDocuments(root) };
}
test("journal preserves complete escaped events in append order after disposal", async context => {
  const { owner } = await fixture(context);
  const document = await owner.create("before </original> & after");
  const writes = [
    document.append("vtt", "add [a/b]\nFINAL"),
    document.append("patch-applied", "complete <caret /> file"),
  ];
  await document.dispose();
  await Promise.all(writes);
  const journal = await fs.readFile(path.join(document.directory, "transcript.md"), "utf8");
  assert.equal(journal, "<original>\nbefore &lt;/original&gt; &amp; after\n</original>\n\n<vtt>\nadd [a/b]\nFINAL\n</vtt>\n\n<patch-applied>\ncomplete &lt;caret /&gt; file\n</patch-applied>\n\n");
  assert.equal(await document.read(), "before </original> & after");
  await assert.rejects(document.append("vtt", "late"), /closed/);
});
test("retention protects active files and survives owner replacement", async context => {
  const { root, owner } = await fixture(context);
  const active = await owner.create("active");
  let last = active;
  for (let index = 0; index < 12; index++) {
    last = await owner.create(`completed ${index}`);
    await last.dispose();
  }
  assert.equal(await active.read(), "active");
  assert.equal((await fs.readdir(root)).length, 10);
  await active.dispose();
  const replacement = new CodexSingleFileDocuments(root);
  const next = await replacement.create("after reload");
  await next.dispose();
  assert.equal((await fs.readdir(root)).length, 10);
  assert.equal(await last.read(), "completed 11");
  assert.equal(await next.read(), "after reload");
});
test("journal failures propagate through later appends and disposal", async context => {
  const { owner } = await fixture(context);
  const document = await owner.create("original");
  const journal = path.join(document.directory, "transcript.md");
  await fs.rename(journal, path.join(document.directory, "saved.md"));
  await fs.mkdir(journal);
  await assert.rejects(document.append("vtt", "input"));
  await assert.rejects(document.append("completed", "must not hide failure"));
  await assert.rejects(document.dispose());
});
