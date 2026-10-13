/* Exports: none; tests protect joined peer fetches, tip-only receives and older-daemon detection. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import { GIT_PEER_NO_BUNDLE_HEADER, GIT_PEER_TIP_HEADER } from "workbench-shared/workbench/git/git-peer-contracts";
import WorkbenchGitPeerRelay, { GitPeerUnsupportedError } from "./WorkbenchGitPeerRelay";

const desktop = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const server = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
const receiver = { daemonId: desktop, projectId: ProjectIdSchema.parse("desktop-checkout") };
const sender = { daemonId: server, projectId: ProjectIdSchema.parse("server-checkout") };
const tip = "b".repeat(40);

function relay(answer: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const retained: string[] = [];
  const source = (id: DaemonId) => ({
    id, available: true, httpOrigin: `http://${id === desktop ? "desktop" : "server"}.test`,
    retain: () => { retained.push(id); return () => { retained.splice(retained.indexOf(id), 1); }; },
    subscribe: () => () => undefined,
    getSnapshot: () => ({ daemonId: id, hostname: id === desktop ? "desktop" : "server", connection: "current" as const,
      generation: 1, failure: null }),
  });
  const instance = new WorkbenchGitPeerRelay({
    sources: { get: source },
    fetcher: (async (input: URL, init: RequestInit) => {
      calls.push({ url: input, init });
      return await answer(input, init);
    }) as typeof fetch,
  });
  return { instance, calls, retained };
}

test("concurrent fetches of one branch join, and a sender with nothing new records its tip without a bundle", async () => {
  let releaseHaves!: () => void;
  const havesGate = new Promise<void>(resolve => { releaseHaves = resolve; });
  const { instance, calls, retained } = relay(async url => {
    if (url.pathname.endsWith("/haves")) {
      await havesGate;
      return Response.json({ haves: [tip] });
    }
    if (url.pathname.endsWith("/bundle")) return new Response(null, { status: 204, headers: { [GIT_PEER_TIP_HEADER]: tip } });
    return Response.json({ tip });
  });
  const first = instance.fetch(sender, receiver, "main");
  const second = instance.fetch(sender, receiver, "main");
  assert.equal(first, second);
  releaseHaves();
  assert.equal(await first, tip);
  assert.deepEqual(calls.map(call => call.url.pathname), ["/daemon/git-peer/haves", "/daemon/git-peer/bundle", "/daemon/git-peer/receive"]);
  const receive = calls[2]!;
  assert.equal(new Headers(receive.init.headers).get(GIT_PEER_NO_BUNDLE_HEADER), "1");
  assert.equal(receive.init.body, undefined);
  assert.deepEqual(retained, []);
});

test("a daemon without peer routes is reported as needing an update", async () => {
  const { instance } = relay(() => new Response(null, { status: 404 }));
  await assert.rejects(instance.fetch(sender, receiver, "main"), GitPeerUnsupportedError);
});
