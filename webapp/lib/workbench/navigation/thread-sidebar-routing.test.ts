/* No production exports. Tests protect home, project, blank, draft, provider, and materialized mosaic route identity. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createHomeHref,
  createHomeThreadHref,
  createPinnedThreadHref,
  createProjectHref,
  createThreadHref,
  getWorkbenchDraftIdFromThreadId,
  getWorkbenchMosaicThreadRootIds,
  isWorkbenchRouteOwnerOfThread,
  isWorkbenchThreadTargetSelected,
  parseWorkbenchRouteFromPath,
} from "./workbench-route";
import { createWorkbenchMosaicSplit, createWorkbenchMosaicTarget, parseWorkbenchMosaicRouteExpression, serializeWorkbenchMosaicRouteExpression } from "./workbench-mosaic-route";

test("/@/ is the canonical projectless home route and root remains an alias", () => {
  assert.equal(createHomeHref(), "/@/");
  const expected = {
    error: "",
    filePath: "",
    mosaicNode: null,
    projectId: "",
    settingsScope: "global",
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "home",
  } as const;
  assert.deepEqual(parseWorkbenchRouteFromPath("/@/"), expected);
  assert.deepEqual(parseWorkbenchRouteFromPath("/"), expected);
});

test("project hrefs preserve slash and reserved-character identities", () => {
  for (const projectId of ["web/workbench", "team space/project%two"]) {
    const route = parseWorkbenchRouteFromPath(createProjectHref(projectId));
    assert.equal(route.view, "project");
    assert.equal(route.projectId, projectId);
  }
});

test("home thread routes preserve the owning project without selecting it", () => {
  const draftId = "123e4567-e89b-42d3-a456-426614174000";
  const folderId = "00000000-0000-4000-8000-000000000010";
  const cases = [
    [{ kind: "new" as const }, "/@/thread/owner/project/@/new"],
    [{ draftId, kind: "draft" as const }, `/@/thread/owner/project/@/new/${draftId}`],
    [{ folderId, kind: "new" as const }, `/@/thread/owner/project/@/folder/${folderId}/thread/new`],
    [{ kind: "provider" as const, threadId: "provider" }, "/@/thread/owner/project/@/provider"],
    [{ kind: "subagent" as const, parentThreadId: "parent", threadId: "child" }, "/@/thread/owner/project/@/parent/sub/child"],
  ] as const;

  for (const [target, expectedHref] of cases) {
    const href = createHomeThreadHref("owner/project", target);
    assert.equal(href, expectedHref);
    const route = parseWorkbenchRouteFromPath(href);
    assert.equal(route.view, "thread");
    assert.equal(route.projectId, "");
    assert.equal(route.threadOwnerProjectId, "owner/project");
    assert.deepEqual(route.threadTarget, target);
  }
});

test("malformed home thread routes never select a project implicitly", () => {
  for (const href of ["/@/thread", "/@/thread/owner", "/@/thread/owner/@", "/@/thread/owner/@/parent/sub"]) {
    const route = parseWorkbenchRouteFromPath(href);
    assert.equal(route.view, "invalid");
    assert.equal(route.projectId, "");
  }
});

test("thread routes discriminate blank drafts and provider ids", () => {
  const draftId = "123e4567-e89b-42d3-a456-426614174000";
  const folderId = "00000000-0000-4000-8000-000000000010";
  assert.deepEqual(parseWorkbenchRouteFromPath("/p/@/thread/new").threadTarget, { kind: "new" });
  assert.deepEqual(parseWorkbenchRouteFromPath(`/p/@/folder/${folderId}/thread/new`).threadTarget, { folderId, kind: "new" });
  assert.deepEqual(parseWorkbenchRouteFromPath(`/p/@/thread/new/${draftId}`).threadTarget, { draftId, kind: "draft" });
  assert.deepEqual(parseWorkbenchRouteFromPath("/p/@/thread/provider-id").threadTarget, { kind: "provider", threadId: "provider-id" });
  assert.deepEqual(parseWorkbenchRouteFromPath("/p/@/thread/parent/sub/child").threadTarget, { kind: "subagent", parentThreadId: "parent", threadId: "child" });
  assert.equal(createThreadHref("p", { kind: "subagent", parentThreadId: "parent", threadId: "child" }), "/p/@/thread/parent/sub/child");
  assert.equal(createThreadHref("p", { draftId, kind: "draft" }), `/p/@/thread/new/${draftId}`);
  assert.equal(createThreadHref("p", { folderId, kind: "new" }), `/p/@/folder/${folderId}/thread/new`);
});

test("pinned routes preserve viewed and owning projects through the existing thread grammar", () => {
  const draftId = "123e4567-e89b-42d3-a456-426614174000";
  const providerHref = createPinnedThreadHref("viewed/project", "owner/project", { kind: "provider", threadId: "provider" });
  assert.equal(providerHref, "/viewed/project/@/pin/owner/project/@/thread/provider");
  assert.deepEqual(parseWorkbenchRouteFromPath(providerHref), {
    ...parseWorkbenchRouteFromPath("/owner/project/@/thread/provider"),
    projectId: "viewed/project",
    threadOwnerProjectId: "owner/project",
  });
  const draftHref = createPinnedThreadHref("viewed", "owner", { draftId, kind: "draft" });
  assert.equal(draftHref, `/viewed/@/pin/owner/@/thread/new/${draftId}`);
  assert.equal(parseWorkbenchRouteFromPath(draftHref).threadTarget?.kind, "draft");
  const subagentHref = createPinnedThreadHref("viewed", "owner", { kind: "subagent", parentThreadId: "parent", threadId: "child" });
  assert.equal(subagentHref, "/viewed/@/pin/owner/@/thread/parent/sub/child");
  assert.equal(parseWorkbenchRouteFromPath("/viewed/@/pin/owner").view, "invalid");
});

test("blank routes own their private future draft identity without owning unrelated drafts", () => {
  const blank = parseWorkbenchRouteFromPath("/p/@/thread/new");
  assert.equal(isWorkbenchRouteOwnerOfThread(blank, "draft:123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(isWorkbenchRouteOwnerOfThread(blank, "provider"), false);
  const draft = parseWorkbenchRouteFromPath("/p/@/thread/new/123e4567-e89b-42d3-a456-426614174000");
  assert.equal(isWorkbenchRouteOwnerOfThread(draft, "draft:123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(isWorkbenchRouteOwnerOfThread(draft, "draft:223e4567-e89b-42d3-a456-426614174000"), false);
  assert.equal(isWorkbenchRouteOwnerOfThread(draft, "provider"), false);
  const provider = parseWorkbenchRouteFromPath("/p/@/thread/provider");
  assert.equal(isWorkbenchRouteOwnerOfThread(provider, "provider"), true);
  assert.equal(isWorkbenchRouteOwnerOfThread(provider, "draft:123e4567-e89b-42d3-a456-426614174000"), false);
});

test("private draft thread ids expose only canonical durable draft identities", () => {
  const draftId = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(getWorkbenchDraftIdFromThreadId(`draft:${draftId}`), draftId);
  assert.equal(getWorkbenchDraftIdFromThreadId("draft:not-a-uuid"), null);
  assert.equal(getWorkbenchDraftIdFromThreadId("provider"), null);
});

test("thread target selection matches the visible root without crossing unrelated identities", () => {
  const provider = { harness: "codex" as const, kind: "provider" as const, threadId: "parent" };
  assert.equal(isWorkbenchThreadTargetSelected(provider, provider), true);
  assert.equal(isWorkbenchThreadTargetSelected(provider, { harness: "codex", kind: "subagent", parentThreadId: "parent", threadId: "child" }), true);
  assert.equal(isWorkbenchThreadTargetSelected(provider, { harness: "opencode", kind: "subagent", parentThreadId: "parent", threadId: "child" }), false);
  assert.equal(isWorkbenchThreadTargetSelected(provider, { harness: "codex", kind: "provider", threadId: "other" }), false);
  assert.equal(isWorkbenchThreadTargetSelected({ draftId: "draft-one", kind: "draft" }, { draftId: "draft-one", kind: "draft" }), true);
  assert.equal(isWorkbenchThreadTargetSelected({ draftId: "draft-one", kind: "draft" }, { draftId: "draft-two", kind: "draft" }), false);
  assert.equal(isWorkbenchThreadTargetSelected({ kind: "new" }, { kind: "new" }), true);
  assert.equal(isWorkbenchThreadTargetSelected({ folderId: "one", kind: "new" }, { folderId: "two", kind: "new" }), false);
  assert.equal(isWorkbenchThreadTargetSelected({ kind: "new" }, null), false);
});

test("missing or malformed draft routes never fall through to provider identity", () => {
  assert.equal(parseWorkbenchRouteFromPath("/p/@/thread/new/not-a-uuid").view, "invalid");
  assert.equal(parseWorkbenchRouteFromPath("/p/@/thread/new/a/b").view, "invalid");
  assert.equal(parseWorkbenchRouteFromPath("/p/@/thread/parent/sub").view, "invalid");
  assert.equal(parseWorkbenchRouteFromPath("/p/@/folder/not-a-uuid/thread/new").view, "invalid");
  assert.equal(parseWorkbenchRouteFromPath("/p/@/folder/00000000-0000-4000-8000-000000000010/thread/provider").view, "invalid");
});

test("mosaic routes preserve parent-owned subagent identity", () => {
  const node = parseWorkbenchMosaicRouteExpression("[thread/parent/sub/child]");
  assert.equal(node.ok, true);
  if (node.ok) assert.equal(serializeWorkbenchMosaicRouteExpression(node.node), "[thread/parent/sub/child]");
});

test("mosaic materialization projects every durable root and excludes non-provider panels", () => {
  const node = createWorkbenchMosaicSplit([
    createWorkbenchMosaicTarget({ kind: "thread", target: { kind: "provider", threadId: "one" } }),
    createWorkbenchMosaicTarget({ filePath: "src/index.ts", kind: "file" }),
    createWorkbenchMosaicTarget({ kind: "thread", target: { kind: "subagent", parentThreadId: "parent", threadId: "child" } }),
    createWorkbenchMosaicTarget({ kind: "thread", target: { kind: "new" } }),
  ]);
  assert.deepEqual([...getWorkbenchMosaicThreadRootIds(node)].sort(), ["one", "parent"]);
});
