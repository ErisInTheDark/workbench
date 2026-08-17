/* No production exports. Tests protect blank, draft, and provider route identity. */
import assert from "node:assert/strict";
import test from "node:test";
import { createThreadHref, getWorkbenchDraftIdFromThreadId, isWorkbenchRouteOwnerOfThread, parseWorkbenchRouteFromPath } from "./workbench-route";
import { parseWorkbenchMosaicRouteExpression, serializeWorkbenchMosaicRouteExpression } from "./workbench-mosaic-route";

test("thread routes discriminate blank drafts and provider ids", () => {
  const draftId = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(parseWorkbenchRouteFromPath("/p/@/thread/new").threadTarget, { kind: "new" });
  assert.deepEqual(parseWorkbenchRouteFromPath(`/p/@/thread/new/${draftId}`).threadTarget, { draftId, kind: "draft" });
  assert.deepEqual(parseWorkbenchRouteFromPath("/p/@/thread/provider-id").threadTarget, { kind: "provider", threadId: "provider-id" });
  assert.deepEqual(parseWorkbenchRouteFromPath("/p/@/thread/parent/sub/child").threadTarget, { kind: "subagent", parentThreadId: "parent", threadId: "child" });
  assert.equal(createThreadHref("p", { kind: "subagent", parentThreadId: "parent", threadId: "child" }), "/p/@/thread/parent/sub/child");
  assert.equal(createThreadHref("p", { draftId, kind: "draft" }), `/p/@/thread/new/${draftId}`);
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

test("missing or malformed draft routes never fall through to provider identity", () => {
  assert.equal(parseWorkbenchRouteFromPath("/p/@/thread/new/not-a-uuid").view, "invalid");
  assert.equal(parseWorkbenchRouteFromPath("/p/@/thread/new/a/b").view, "invalid");
  assert.equal(parseWorkbenchRouteFromPath("/p/@/thread/parent/sub").view, "invalid");
});

test("removed Collaboration routes are invalid", () => {
  assert.equal(parseWorkbenchRouteFromPath("/p/@/collaboration").view, "invalid");
});

test("mosaic routes preserve parent-owned subagent identity", () => {
  const node = parseWorkbenchMosaicRouteExpression("[thread/parent/sub/child]");
  assert.equal(node.ok, true);
  if (node.ok) assert.equal(serializeWorkbenchMosaicRouteExpression(node.node), "[thread/parent/sub/child]");
});
