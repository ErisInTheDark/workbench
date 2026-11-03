/*
 * No exports: the module worker behind SkillComponentWorkerClient. Each session keeps its thread's component bundles and
 * one sandboxed runtime over them, and answers renders with validated trees off the page's main thread.
 */
import SkillComponentRuntime from "workbench-shared/workbench/skills/SkillComponentRuntime";
import type { SkillComponentBundle } from "workbench-shared/workbench/skills/skill-component-contract";
import { listThreadComponentImageUrls } from "workbench-shared/workbench/thread/thread-component-tree";
import { listMarkdownComponentInvocations } from "../markdown/markdown-component-invocations";
import loadQuickJS from "./load-quickjs";
import type { SkillComponentWorkerRequest, SkillComponentWorkerResponse } from "./SkillComponentWorkerClient";

declare function postMessage(message: SkillComponentWorkerResponse): void;
declare function addEventListener(type: "message", listener: (event: MessageEvent<SkillComponentWorkerRequest>) => void): void;

const sessions = new Map<number, { bundles: readonly SkillComponentBundle[]; runtime: SkillComponentRuntime | null }>();
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

async function render(request: Extract<SkillComponentWorkerRequest, { type: "render" }>) {
  const session = sessions.get(request.session);
  if (!session) throw new Error("Skill components are not loaded.");
  session.runtime ??= new SkillComponentRuntime(await loadQuickJS(), session.bundles, { nestedInvocations: listMarkdownComponentInvocations });
  const tree = session.runtime.render(request.request);
  return { tree, imageUrls: listThreadComponentImageUrls(tree) };
}

// One queue keeps every session's load ahead of the renders sent after it.
let queue = Promise.resolve();
addEventListener("message", ({ data: request }) => {
  queue = queue.then(async () => {
    if (request.type === "render") {
      try { postMessage({ id: request.id, render: await render(request) }); }
      catch (error) { postMessage({ id: request.id, error: describe(error) }); }
      return;
    }
    const session = sessions.get(request.session);
    if (request.type === "close") {
      session?.runtime?.dispose();
      sessions.delete(request.session);
    } else if (session?.runtime?.key !== SkillComponentRuntime.keyOf(request.bundles)) {
      // Unchanged bundles keep their warm contexts.
      session?.runtime?.dispose();
      sessions.set(request.session, { bundles: request.bundles, runtime: null });
    }
  });
});
