/* No production exports. Protect vis page serving: the document with its bridge and stored controls, build-root files, the own-origin-only policy, and that no path or link escapes the build root. */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import type { VisVariant } from "workbench-shared/workbench/vis/vis-url";
import type { VisServed } from "./WorkbenchVisController";
import WorkbenchVisHttpController from "./WorkbenchVisHttpController";

const SESSION = "22222222-2222-4222-8222-222222222222";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("vis-http-");
  context.after(() => temporary.dispose());
  const root = path.join(temporary.path, "project");
  await mkdir(path.join(root, "static"), { recursive: true });
  await writeFile(path.join(root, "static", "item.png"), "png-bytes");
  await writeFile(path.join(temporary.path, "secret.txt"), "outside");
  const served = new Map<VisVariant, VisServed>([
    ["live", { document: "<!doctype html><p>live</p>", rootPath: root, controls: { tab: "\"card\"" } }],
    ["end", { document: "<p>ended</p>", rootPath: root, controls: {} }],
  ]);
  const controller = new WorkbenchVisHttpController({
    serve: async (sessionId, variant) => sessionId === SESSION ? served.get(variant) ?? null : null,
  });
  const server = http.createServer((request, response) => void controller.handleHttpRequest(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (pathname: string) => fetch(`${origin}/daemon/vis/${SESSION}/${pathname}`);
  return { root, temporary, get };
}

test("the document carries its bridge, the stored controls and the requested audience, under an own-origin-only policy", async context => {
  const f = await fixture(context);
  const response = await f.get("live/?wb-audience=agent&wb-theme=winter");
  assert.equal(response.status, 200);
  const policy = response.headers.get("content-security-policy") ?? "";
  assert.match(policy, /default-src 'self'/u);
  assert.doesNotMatch(policy, /https?:|\*/u, "no other origin is ever allowed");
  const html = await response.text();
  assert.ok(html.startsWith("<!doctype html>"), "the doctype stays first");
  assert.match(html, /"tab":"card"/u);
  assert.match(html, /audience:"agent"/u);
  assert.match(html, /theme\("winter"\)/u);
  assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/u, "the header owns the policy");
  assert.equal(await (await f.get("end/")).text().then(text => text.endsWith("<p>ended</p>")), true);
  assert.equal((await f.get("start/")).status, 404, "a variant with nothing stored is not found");
});

test("files under the build root are served with their type; nothing outside it is", async context => {
  const f = await fixture(context);
  const asset = await f.get("live/static/item.png");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert.equal(await asset.text(), "png-bytes");
  assert.equal((await f.get("live/static")).status, 404, "folders are not files");
  assert.equal((await f.get("live/%2e%2e/secret.txt")).status, 404);
  assert.equal((await f.get("live/missing.png")).status, 404);
  // Windows refuses symlinks without developer mode; the containment rule is the same either way.
  const linked = await symlink(path.join(f.temporary.path, "secret.txt"), path.join(f.root, "link.txt")).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPERM") throw error;
    return false;
  });
  if (linked) assert.equal((await f.get("live/link.txt")).status, 404, "a link cannot reach outside the build root");
});
