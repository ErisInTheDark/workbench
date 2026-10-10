/* No production exports. Protect the vis browser's page (framed current render, no network), snapshot text, screenshot image references, surfaced Browse failures, and cleanup on end. */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import type { WorkbenchBrowseAgentScriptInlineRequest } from "workbench-shared/types";
import { parseVisScreenshotImage } from "workbench-shared/workbench/vis/vis-contract";
import WorkbenchVisBrowse from "./WorkbenchVisBrowse";

async function fixture(context: TestContext, reply: (request: WorkbenchBrowseAgentScriptInlineRequest) => Response) {
  const temporary = await WorkbenchTemporaryDirectory.create("vis-browse-");
  context.after(() => temporary.dispose());
  const requests: WorkbenchBrowseAgentScriptInlineRequest[] = [];
  const stops: string[] = [];
  const logs: string[] = [];
  const browse = new WorkbenchVisBrowse({
    directory: temporary.path,
    port: {
      execute: async request => { requests.push(request); return reply(request); },
      stop: async request => { stops.push(request.session); },
    },
    log: message => logs.push(message),
  });
  const target = { sessionId: "0123456789abcdef", threadId: "thread", cwd: temporary.path, path: "mock.tsx", document: "<p>hi</p>" };
  return { browse, requests, stops, logs, target };
}

/** Script requests answer with one command response whose stdout joins every line's pretty-printed JSON. */
const reply = (stdout: string) => Response.json({ ok: true, durationMs: 1, exitCode: 0, stderr: "", stdout });
const json = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

test("a snapshot opens the framed current render in the session's browser and returns its tree", async context => {
  const f = await fixture(context, request => request.script.startsWith("open ")
    ? reply(`${json({ url: "file:///page" })}${json({ waited: true })}`)
    : reply(json({ tree: "[0-1] RootWebArea" })));
  assert.equal(await f.browse.inspect(f.target, "snapshot"), "[0-1] RootWebArea\n");
  const [request] = f.requests;
  assert.equal(request!.session, "vis-01234567");
  assert.ok(f.requests.every(({ hiddenScreenshots }) => hiddenScreenshots === true), "vis checks stay out of the user's transcript");
  const page = fileURLToPath(/^open (\S+)/u.exec(request!.script)![1]!);
  const html = await readFile(page, "utf8");
  assert.match(html, /Content-Security-Policy[^>]*default-src 'none'/u);
  assert.ok(html.endsWith("<p>hi</p>"));
  await f.browse.end(f.target);
  assert.deepEqual(f.stops, ["vis-01234567"]);
  await assert.rejects(access(page), /ENOENT/u);
});

test("a screenshot names the stored image so its transcript entry can show it", async context => {
  const assetUrl = "/api/transcript-assets/thread/shot.png";
  const f = await fixture(context, request => request.script.startsWith("open ")
    ? reply(json({ url: "file:///page" }))
    : reply(json({ screenshot: "captured", assetUrl, injected: true })));
  const output = await f.browse.inspect(f.target, "screenshot");
  assert.equal(parseVisScreenshotImage(output), assetUrl);
  assert.equal(parseVisScreenshotImage("Image: https://example.com/x.png"), null, "only Workbench transcript assets render");
});

test("a failed Browse step surfaces its error; a failed eager open only warns", async context => {
  const f = await fixture(context, () => Response.json({ ok: false, durationMs: 1, exitCode: 1, stderr: "", stdout: "", error: "net::ERR_FILE_NOT_FOUND" }));
  await assert.rejects(f.browse.inspect(f.target, "screenshot"), /ERR_FILE_NOT_FOUND/u);
  await f.browse.open(f.target);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0]!, /could not open: net::ERR_FILE_NOT_FOUND/u);
});
