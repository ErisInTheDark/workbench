/* No production exports. Protect one thread's extension loading, render sharing, kept snapshots and image routing. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import SkillMcpMatcherRuntime from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import type { SkillComponentRequest, SkillComponentTarget, SkillExtensions } from "workbench-shared/workbench/skills/skill-component-contract";
import type { SkillMcpMatcherBundle } from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import type { ThreadComponentNode } from "workbench-shared/workbench/thread/thread-component-tree";
import type { SkillComponentRender } from "./SkillComponentWorkerClient";
import ThreadSkillExtensionsController, { type ThreadSkillComponentState, type ThreadSkillExtensionsPorts } from "./ThreadSkillExtensionsController";

let quickjs: QuickJSWASMModule;
const runtimes: SkillMcpMatcherRuntime[] = [];
before(async () => { quickjs = await newQuickJSWASMModuleFromVariant(variant); });
after(() => { for (const runtime of runtimes) runtime.dispose(); });

const node = (children: string, props: Record<string, string> = {}): ThreadComponentNode => ({ $workbench: "element", type: "div", props: { ...props, children } });
const bundle = (revision: string) => ({ skillName: "cards", skillPath: "/skills/cards/SKILL.md", revision: revision.repeat(64), components: ["Card"], code: "x" });
const matcher = (revision: string): SkillMcpMatcherBundle => ({ skillName: "cards", skillPath: "/skills/cards/SKILL.md", revision: revision.repeat(64), code: "var __wbSkillMcpMatchers = { default: [] };" });
const extensions = (overrides: Partial<SkillExtensions> = {}): SkillExtensions => ({
  matchers: [matcher("a")], components: [bundle("a")], styles: [{ path: "/skills/cards/SKILL.md", revision: "c".repeat(64), css: ".card{}" }],
  failures: [], ...overrides,
});

function harness(overrides: Partial<ThreadSkillExtensionsPorts> = {}) {
  const calls = { extensions: 0, renders: [] as SkillComponentRequest[], results: [] as string[][], kept: [] as SkillComponentTarget[], keep: [] as SkillComponentTarget[], images: [] as string[][], loads: 0, closed: 0 };
  let next: SkillExtensions = extensions();
  const ports: ThreadSkillExtensionsPorts = {
    extensions: async () => { calls.extensions += 1; return next; },
    results: async names => { calls.results.push([...names]); return {}; },
    images: async urls => { calls.images.push([...urls]); return {}; },
    keep: async target => { calls.keep.push(target); },
    kept: async target => { calls.kept.push(target); return null; },
    evaluator: () => ({
      load: () => { calls.loads += 1; },
      render: async request => { calls.renders.push(request); return { tree: node(JSON.stringify(request)), imageUrls: [] }; },
      close: () => { calls.closed += 1; },
    }),
    matchers: async bundles => { const runtime = new SkillMcpMatcherRuntime(quickjs, bundles); runtimes.push(runtime); return runtime; },
    warn: () => {},
    ...overrides,
  };
  const controller = new ThreadSkillExtensionsController(ports);
  const until = (done: () => boolean) => new Promise<void>(resolve => {
    if (done()) { resolve(); return; }
    const stop = controller.subscribe(() => { if (done()) { stop(); resolve(); } });
  });
  const settled = async (key: string): Promise<ThreadSkillComponentState> => {
    await until(() => controller.peek(key).status !== "pending");
    return controller.peek(key);
  };
  return { calls, controller, until, settled, setNext: (value: SkillExtensions) => { next = value; } };
}

/** Every pending promise continuation has run once this resolves. */
const drained = () => new Promise<void>(resolve => { setImmediate(resolve); });

test("unchanged matchers keep their runtime across skill changes; changed ones replace it", async () => {
  const { controller, setNext, calls } = harness();
  controller.setSkills("one", true);
  await drained();
  const first = controller.snapshot().matchers;
  assert.ok(first);
  assert.equal(controller.snapshot().css, ".card{}");
  setNext(extensions({ styles: [] }));
  controller.setSkills("two", true);
  await drained();
  assert.equal(controller.snapshot().css, "", "the reload landed");
  assert.equal(controller.snapshot().matchers, first);
  setNext(extensions({ matchers: [matcher("b")] }));
  controller.setSkills("three", true);
  await drained();
  assert.notEqual(controller.snapshot().matchers, first);
  assert.notEqual(controller.snapshot().matchers, null);
  controller.setSkills("three", true);
  assert.equal(calls.extensions, 3, "the same skills never reload");
});

test("a superseded load publishes nothing", async () => {
  let release!: (value: SkillExtensions) => void;
  let loads = 0;
  const { controller } = harness({ extensions: () => loads++ === 0
    ? new Promise(resolve => { release = resolve; })
    : Promise.resolve(extensions({ components: [bundle("b")], styles: [] })) });
  controller.setSkills("old", true);
  controller.setSkills("new", true);
  await drained();
  release(extensions());
  await drained();
  assert.equal(controller.snapshot().css, "");
});

test("held renders share one evaluation per key and loaded components", async () => {
  const { controller, until, settled, calls } = harness();
  controller.setSkills("one", true);
  await until(() => controller.snapshot().key !== null);
  const request = { kind: "message" as const, itemId: "item", markup: "<Card />" };
  const releaseOne = controller.hold("card", request);
  const releaseTwo = controller.hold("card", request);
  assert.equal((await settled("card")).status, "ready");
  releaseOne(); releaseTwo();
  controller.hold("card", request)();
  assert.equal(calls.renders.length, 1);
  assert.deepEqual(calls.keep, [], "a message without kept results needs no snapshot");
});

test("a message naming kept results fetches each once, keeps its snapshot, and draws that snapshot once they are gone", async () => {
  let live = true;
  const { controller, until, settled, calls } = harness({
    results: async names => { calls.results.push([...names]); return live ? { cards: [1] } : {}; },
    kept: async target => { calls.kept.push(target); return node("kept"); },
  });
  controller.setSkills("one", true);
  await until(() => controller.snapshot().key !== null);
  const markup = '<Card cards="@result:cards" />';
  controller.hold("a", { kind: "message", itemId: "a", markup });
  controller.hold("b", { kind: "message", itemId: "b", markup });
  await settled("a"); await settled("b");
  assert.deepEqual(calls.results, [["cards"]]);
  assert.deepEqual(calls.renders.map(request => request.kind === "markup" ? request.results : null), [{ cards: [1] }, { cards: [1] }]);
  assert.deepEqual(calls.keep, [{ kind: "message", itemId: "a", markup }, { kind: "message", itemId: "b", markup }]);

  live = false;
  const settledThread = harness({
    results: async () => ({}),
    kept: async target => { calls.kept.push(target); return node("kept"); },
  });
  settledThread.controller.setSkills("one", true);
  await settledThread.until(() => settledThread.controller.snapshot().key !== null);
  settledThread.controller.hold("c", { kind: "message", itemId: "c", markup });
  assert.deepEqual(await settledThread.settled("c"), { status: "ready", tree: node("kept") });
  assert.deepEqual(settledThread.calls.renders, [], "no stub render once the results are gone");
});

test("an expired call draws its snapshot; a live one renders with its kept result and keeps a snapshot", async () => {
  const { controller, until, settled, calls } = harness({
    results: async names => { calls.results.push([...names]); return { b1: { builds: 1 } }; },
    kept: async target => { calls.kept.push(target); return target.itemId === "old" ? node("snapshot") : null; },
  });
  controller.setSkills("one", true);
  await until(() => controller.snapshot().key !== null);
  const call = { server: "devops", tool: "builds", arguments: {}, keep: "b1", status: "completed", error: null, result: "Saved." };
  const request = (itemId: string, expired: boolean) => ({
    kind: "call" as const, itemId, skillPath: "/skills/cards/SKILL.md", component: "Card", props: { call }, keep: "b1", expired,
  });
  controller.hold("old", request("old", true));
  assert.deepEqual(await settled("old"), { status: "ready", tree: node("snapshot") });
  assert.deepEqual(calls.renders, []);
  controller.hold("new", request("new", false));
  assert.equal((await settled("new")).status, "ready");
  assert.deepEqual(calls.renders, [{ kind: "props", skillPath: "/skills/cards/SKILL.md", component: "Card", props: { call: { ...call, result: { builds: 1 } } } }]);
  assert.deepEqual(calls.keep, [{ kind: "call", itemId: "new", skillPath: "/skills/cards/SKILL.md", component: "Card" }]);
});

test("public images resolve through the daemon once each, and ones it cannot fetch are dropped", async () => {
  const image = "https://img.example.test/a.png";
  const { controller, until, settled, calls } = harness({
    images: async urls => { calls.images.push([...urls]); return { [image]: "data:image/png;base64,AAAA" }; },
    evaluator: () => ({
      load: () => {},
      render: async (): Promise<SkillComponentRender> => ({
        tree: { $workbench: "element", type: "div", props: { children: [
          { $workbench: "element", type: "img", props: { src: image } },
          { $workbench: "element", type: "img", props: { src: "https://img.example.test/gone.png" } },
        ] } },
        imageUrls: [image, "https://img.example.test/gone.png"],
      }),
      close: () => {},
    }),
  });
  controller.setSkills("one", true);
  await until(() => controller.snapshot().key !== null);
  controller.hold("x", { kind: "inline", skillPath: "/skills/cards/SKILL.md", component: "Card", props: {} });
  controller.hold("y", { kind: "inline", skillPath: "/skills/cards/SKILL.md", component: "Card", props: { other: 1 } });
  const state = await settled("x");
  await settled("y");
  assert.deepEqual(state, { status: "ready", tree: { $workbench: "element", type: "div", props: { children: [
    { $workbench: "element", type: "img", props: { src: "data:image/png;base64,AAAA" } },
    { $workbench: "element", type: "img", props: {} },
  ] } } });
  assert.deepEqual(calls.images, [[image, "https://img.example.test/gone.png"]]);
});

test("a failed render says why, and no skills means components fail at once", async () => {
  const { controller, until, settled } = harness({
    evaluator: () => ({ load: () => {}, render: async () => { throw new Error("No active skill exposes component Card."); }, close: () => {} }),
  });
  controller.setSkills("[]", false);
  await until(() => controller.snapshot().key !== null);
  assert.equal(controller.snapshot().matchers, null);
  controller.hold("card", { kind: "message", itemId: "item", markup: "<Card />" });
  assert.deepEqual(await settled("card"), { status: "failed", error: "No active skill exposes component Card." });
});

test("disposing closes its worker session", () => {
  const { controller, calls } = harness();
  controller.dispose();
  controller.dispose();
  assert.equal(calls.closed, 1);
});
