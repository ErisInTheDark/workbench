/* No production exports. Protect that saved component trees carry their images inline and never a remote URL. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readThreadComponentTree } from "workbench-shared/workbench/thread/thread-component-tree";
import { inlineComponentImages, type ComponentImageFetch } from "./component-images";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const element = (type: string, props: Record<string, unknown>) => ({ $workbench: "element" as const, type, props }) as never;

test("public images in img src and style url() become data URLs, and failed or non-image ones are dropped", async () => {
  const tree = readThreadComponentTree(element("div", { children: [
    element("img", { src: "https://img.example.test/avatar.png", alt: "Chiri" }),
    element("img", { src: "https://img.example.test/page.html", alt: "page" }),
    element("img", { src: "https://img.example.test/missing.png", alt: "missing" }),
    element("div", { style: { backgroundImage: 'url("https://img.example.test/avatar.png")' } }),
  ] }), { remoteImages: true });
  const fetched: string[] = [];
  const fetchImage: ComponentImageFetch = async url => {
    fetched.push(url);
    if (url.endsWith("missing.png")) throw new Error("HTTP 404");
    return { contentType: url.endsWith(".html") ? "text/html" : "image/png", bytes: PNG };
  };
  const inlined = await inlineComponentImages(tree, fetchImage);
  const json = JSON.stringify(inlined);
  assert.equal(json.includes("https://"), false, "no remote URL survives");
  assert.equal(fetched.filter(url => url.endsWith("avatar.png")).length, 1, "a repeated image is fetched once");
  const [avatar, page, missing, background] = (inlined.props.children as { props: Record<string, unknown> }[]);
  assert.equal(avatar!.props.src, `data:image/png;base64,${PNG.toString("base64")}`);
  assert.equal(page!.props.src, undefined);
  assert.equal(missing!.props.alt, "missing");
  assert.match(JSON.stringify(background!.props.style), /data:image\/png;base64/u);
  assert.deepEqual(readThreadComponentTree(inlined), inlined, "the inlined tree passes the strict check");
});

test("strict trees still refuse remote images", () => {
  assert.throws(() => readThreadComponentTree(element("img", { src: "https://img.example.test/a.png" })));
  assert.throws(() => readThreadComponentTree(element("div", { style: { background: "url(https://img.example.test/a.png)" } })));
  assert.throws(() => readThreadComponentTree(element("div", { src: "https://img.example.test/a.png" }), { remoteImages: true }),
    "only img elements may name remote images");
});
