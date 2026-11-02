/* No production exports. Protect the vis browser's page (the served render framed in the card's sandbox; previews standalone with no network), waiting for the page to settle before a check, snapshot text, screenshot image references, surfaced Browse failures, and cleanup on end. */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import type { WorkbenchBrowseAgentScriptInlineRequest } from "workbench-shared/types";
import { parseVisScreenshotImage } from "workbench-shared/workbench/vis/vis-contract";
import { VIS_FRAME_SANDBOX, type VisFrameSettle } from "workbench-shared/workbench/vis/vis-frame";
import WorkbenchVisBrowse from "./WorkbenchVisBrowse";

const SESSION = "01234567-89ab-4cde-8f01-23456789abcd";

async function fixture(context: TestContext, reply: (request: WorkbenchBrowseAgentScriptInlineRequest) => Response, visOrigin: string | null = "http://127.0.0.1:4000") {
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
    visOrigin: () => visOrigin,
    log: message => logs.push(message),
  });
  const target = { sessionId: SESSION, threadId: "thread", cwd: temporary.path, path: "mock.tsx", revision: 7 };
  return { browse, requests, stops, logs, target };
}

/** Script requests answer with one command response whose stdout joins every line's pretty-printed JSON. */
const reply = (stdout: string) => Response.json({ ok: true, durationMs: 1, exitCode: 0, stderr: "", stdout });
const json = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

const stepOf = (request: WorkbenchBrowseAgentScriptInlineRequest) =>
  request.script.startsWith("open ") ? "open" : request.script.startsWith("```js") ? "settle" : "check";

/** Answers each step of a check: opening the page, waiting for it to settle, then the snapshot or screenshot itself. */
const steps = (check: object, settle: VisFrameSettle = "quiet") => (request: WorkbenchBrowseAgentScriptInlineRequest) => {
  const step = stepOf(request);
  if (step === "open") return reply(`${json({ url: "file:///page" })}${json({ viewport: true })}`);
  return reply(json(step === "settle" ? { result: settle } : check));
};

async function openedPage(request: WorkbenchBrowseAgentScriptInlineRequest) {
  const page = fileURLToPath(/^open (\S+)/u.exec(request.script)![1]!);
  return { page, html: await readFile(page, "utf8") };
}

test("a successful HTTP response cannot hide a failed browser stop", async () => {
  await assert.rejects(
    WorkbenchVisBrowse.checkStopResponse(Response.json({ stopped: false, result: { ok: false, error: "stop failed" } })),
    /stop failed/u,
  );
  await WorkbenchVisBrowse.checkStopResponse(Response.json({ stopped: true, result: { ok: true } }));
});

test("a snapshot frames the session's served render the way the card does and returns its tree", async context => {
  const f = await fixture(context, steps({ tree: "[0-1] RootWebArea" }));
  assert.equal(await f.browse.inspect(f.target, "snapshot"), "[0-1] RootWebArea\n");
  const [request] = f.requests;
  assert.equal(request!.session, "vis-01234567");
  assert.ok(f.requests.every(({ hiddenScreenshots }) => hiddenScreenshots === true), "vis checks stay out of the user's transcript");
  const { page, html } = await openedPage(request!);
  const frame = /<iframe sandbox="([^"]*)" src="([^"]*)"/u.exec(html);
  assert.equal(frame?.[1], VIS_FRAME_SANDBOX, "the check gets the card's origin rules, storage included");
  const url = new URL(frame![2]!.replaceAll("&amp;", "&"));
  assert.equal(`${url.origin}${url.pathname}`, `http://127.0.0.1:4000/daemon/vis/${SESSION}/live/`);
  assert.equal(url.searchParams.get("wb-audience"), "agent");
  await f.browse.end(f.target);
  assert.deepEqual(f.stops, ["vis-01234567"]);
  await assert.rejects(access(page), /ENOENT/u);
});

test("a refresh points the page a reload opens at the newer render, without driving the browser, until the vis ends", async context => {
  const f = await fixture(context, () => reply(json({ url: "file:///page" })));
  await f.browse.open(f.target);
  const { page } = await openedPage(f.requests[0]!);
  const refreshed = f.browse.refresh({ ...f.target, revision: 8 });
  const ended = f.browse.end(f.target);
  await refreshed;
  await ended;
  assert.equal(f.requests.length, 1, "a refresh never navigates the session");
  await assert.rejects(access(page), /ENOENT/u, "a refresh queued before the end cannot bring the page back");

  const live = { ...f.target, sessionId: "fedcba98-7654-4321-8fed-cba987654321", revision: 9 };
  await f.browse.refresh(live);
  assert.match(await readFile(page.replace(f.target.sessionId, live.sessionId), "utf8"), /wb-r=9/u);
});

test("a preview screenshots its document standalone, with no network", async context => {
  const f = await fixture(context, steps({ screenshot: "captured", assetUrl: "/api/transcript-assets/thread/shot.png" }));
  await f.browse.inspectDocument({ ...f.target, document: "<p>hi</p>" });
  assert.deepEqual(f.requests.map(stepOf), ["open", "check"], "a static preview has no frame to wait on");
  const { html } = await openedPage(f.requests[0]!);
  assert.match(html, /Content-Security-Policy[^>]*default-src 'none'/u);
  assert.ok(html.endsWith("<p>hi</p>"));
});

test("a screenshot names the stored image so its transcript entry can show it", async context => {
  const assetUrl = "/api/transcript-assets/thread/shot.png";
  const f = await fixture(context, steps({ screenshot: "captured", assetUrl, injected: true }));
  const output = await f.browse.inspect(f.target, "screenshot");
  assert.equal(parseVisScreenshotImage(output), assetUrl);
  assert.equal(parseVisScreenshotImage("Image: https://example.com/x.png"), null, "only Workbench transcript assets render");
});

test("a check captures once the page settles, and says when it never did", async context => {
  const assetUrl = "/api/transcript-assets/thread/shot.png";
  const quiet = await fixture(context, steps({ screenshot: "captured", assetUrl }));
  const settled = await quiet.browse.inspect(quiet.target, "screenshot");
  assert.deepEqual(quiet.requests.map(stepOf), ["open", "settle", "check"]);
  assert.doesNotMatch(settled, /still changing/u);

  const busy = await fixture(context, steps({ tree: "[0-1] RootWebArea" }, "busy"));
  const snapshot = await busy.browse.inspect(busy.target, "snapshot");
  assert.ok(snapshot.startsWith("[0-1] RootWebArea\n"));
  assert.match(snapshot, /still changing/u);
});

test("a screenshot without an image reports failure", async context => {
  const f = await fixture(context, steps({ screenshot: "captured" }));
  await assert.rejects(f.browse.inspect(f.target, "screenshot"), /screenshot.*image/i);
});

test("strict cleanup reports a failed browser stop", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("vis-cleanup-");
  context.after(() => temporary.dispose());
  const browse = new WorkbenchVisBrowse({
    directory: temporary.path,
    port: {
      execute: async () => reply(json({})),
      stop: async () => { throw new Error("browser stop failed"); },
    },
    visOrigin: () => null,
    log: () => {},
  });
  await assert.rejects(browse.end({ sessionId: "test", threadId: "thread", cwd: temporary.path }, { strict: true }), /cleanup/i);
});

test("a failed Browse step surfaces its error; a failed eager open only warns", async context => {
  const f = await fixture(context, () => Response.json({ ok: false, durationMs: 1, exitCode: 1, stderr: "", stdout: "", error: "net::ERR_FILE_NOT_FOUND" }));
  await assert.rejects(f.browse.inspect(f.target, "screenshot"), /ERR_FILE_NOT_FOUND/u);
  await f.browse.open(f.target);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0]!, /could not open: net::ERR_FILE_NOT_FOUND/u);
});

test("checks fail plainly while the daemon's vis listener is down", async context => {
  const f = await fixture(context, () => reply(json({})), null);
  await assert.rejects(f.browse.inspect(f.target, "snapshot"), /vis listener/u);
  assert.equal(f.requests.length, 0);
});
