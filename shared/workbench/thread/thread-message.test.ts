/*
 * Exports: none. Tests protect global thread-message target and user-visible simple version validation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkbenchThreadMessageRequestSchema } from "./thread-message";

const request = {
  callerThreadId: "reviewer",
  cwd: "C:/repo",
  message: "Please fix the cancellation race.",
  userVisibleSimpleVersion: "Asked for the cancellation fix.",
};

test("thread messages require exactly one relationship or thread target", () => {
  assert.equal(WorkbenchThreadMessageRequestSchema.safeParse({ ...request, threadId: "target" }).success, true);
  assert.equal(WorkbenchThreadMessageRequestSchema.safeParse({ ...request, name: "luna" }).success, true);
  assert.equal(WorkbenchThreadMessageRequestSchema.safeParse({ ...request, parent: true }).success, true);
  assert.equal(WorkbenchThreadMessageRequestSchema.safeParse(request).success, false);
  assert.equal(WorkbenchThreadMessageRequestSchema.safeParse({ ...request, parent: true, threadId: "target" }).success, false);
});

test("thread messages require a non-blank user-visible simple version", () => {
  const { userVisibleSimpleVersion: _omitted, ...withoutSimpleVersion } = request;
  assert.equal(WorkbenchThreadMessageRequestSchema.safeParse({ ...withoutSimpleVersion, threadId: "target" }).success, false);
  assert.equal(WorkbenchThreadMessageRequestSchema.safeParse({ ...request, threadId: "target", userVisibleSimpleVersion: "  " }).success, false);
});
