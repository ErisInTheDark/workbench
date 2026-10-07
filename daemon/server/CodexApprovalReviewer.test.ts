/*
 * No production exports. Tests protect the codex-auto-review boundary: only a low/medium-risk allow decides,
 * and broken turns or replies never decide.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodexIsolatedRequest, CodexIsolatedTransport } from "./CodexIsolatedAppServerTransport";
import CodexApprovalReviewer, { parseCodexReviewVerdict } from "./CodexApprovalReviewer";

test("only an allow at low or medium risk decides; everything else asks the person", () => {
  const verdict = (decision: string, risk: string) => parseCodexReviewVerdict(JSON.stringify({ decision, risk, rationale: "Reads a log." }));
  assert.equal(verdict("allow", "low").decision, "allow");
  assert.equal(verdict("allow", "medium").decision, "allow");
  assert.equal(verdict("allow", "high").decision, "manual");
  assert.equal(verdict("deny", "low").decision, "manual");
  assert.throws(() => parseCodexReviewVerdict("sure, go ahead"), /not JSON/u);
  assert.throws(() => parseCodexReviewVerdict(JSON.stringify({ decision: "allow" })), /unexpected/u);
});

function fakeCodex(finish: (emit: (message: unknown) => Promise<void>, threadId: string) => Promise<void>) {
  const requests: CodexIsolatedRequest[] = [];
  const reviewer = new CodexApprovalReviewer({
    reviewDirectory: "C:/scratch/review",
    createTransport: (onMessage): CodexIsolatedTransport => ({
      async request(request) {
        requests.push(request);
        if (request.method === "thread/start") return { thread: { id: "review-thread" } };
        if (request.method === "turn/start") queueMicrotask(() => void finish(onMessage, "review-thread"));
        return {};
      },
      respond() {},
      async dispose() {},
    }),
  });
  return { reviewer, requests };
}

test("a review runs one ephemeral read-only thread on the auto-review model and returns its verdict", async () => {
  const { reviewer, requests } = fakeCodex(async (emit, threadId) => {
    await emit({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text: JSON.stringify({ decision: "allow", risk: "low", rationale: "Lists files." }) } } });
    await emit({ method: "turn/completed", params: { threadId, turn: { id: "t", status: "completed" } } });
  });
  const verdict = await reviewer.review("ls C:/", new AbortController().signal);
  assert.equal(verdict.decision, "allow");
  const start = requests.find(request => request.method === "thread/start")!;
  assert.ok(start.method === "thread/start");
  assert.equal(start.params.model, "codex-auto-review");
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(start.params.allowProviderModelFallback, false);
  await reviewer.dispose();
});

test("a failed or verdict-less turn rejects instead of deciding", async () => {
  const failed = fakeCodex(async (emit, threadId) => {
    await emit({ method: "turn/completed", params: { threadId, turn: { id: "t", status: "failed", error: { message: "model not available" } } } });
  });
  await assert.rejects(failed.reviewer.review("ls", new AbortController().signal), /model not available/u);
  const silent = fakeCodex(async (emit, threadId) => {
    await emit({ method: "turn/completed", params: { threadId, turn: { id: "t", status: "completed" } } });
  });
  await assert.rejects(silent.reviewer.review("ls", new AbortController().signal), /without a verdict/u);
});
