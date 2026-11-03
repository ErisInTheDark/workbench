/*
 * No production exports. Protect what a parent's forward or denial does to its child's outside-sandbox request: what the user
 * is shown, which decision reaches the child, and refusals that decide nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchApprovalDecision, WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import { resolveSubagentApproval } from "./subagent-approvals";

const command: WorkbenchApprovalSubject = {
  kind: "command", command: "pnpm install", cwd: "C:/other", commandActions: [], justification: "Install deps.",
  networkTarget: null, rememberable: true,
};

function child(pending: Array<{ requestKey: string; subject: WorkbenchApprovalSubject }>, answer: WorkbenchApprovalDecision = { kind: "allowOnce" }) {
  const asked: WorkbenchApprovalSubject[] = [];
  const decided: Array<[string, WorkbenchApprovalDecision]> = [];
  return {
    asked, decided,
    input: {
      name: "Marigold",
      read: async () => pending,
      decide: async (requestKey: string, decision: WorkbenchApprovalDecision) => { decided.push([requestKey, decision]); },
      ask: async (subject: WorkbenchApprovalSubject) => { asked.push(subject); return answer; },
    },
  };
}

const signal = new AbortController().signal;

test("forwarding names the child in the user's prompt unless replaced, saves no rule, and passes the user's decision on", async () => {
  const kept = child([{ requestKey: "key", subject: command }]);
  assert.match(await resolveSubagentApproval(kept.input, { kind: "forward", justification: null }, signal), /approved/u);
  assert.deepEqual(kept.asked, [{ ...command, justification: "Marigold: Install deps.", rememberable: false }]);
  assert.deepEqual(kept.decided, [["key", { kind: "allowOnce" }]]);

  const replaced = child([{ requestKey: "key", subject: { kind: "patch", reason: null, grantRoot: null, paths: ["a"] } }], { kind: "decline" });
  assert.match(await resolveSubagentApproval(replaced.input, { kind: "forward", justification: "Needs the generated file." }, signal), /denied/u);
  assert.deepEqual(replaced.asked, [{ kind: "patch", reason: "Needs the generated file.", grantRoot: null, paths: ["a"] }]);
  assert.deepEqual(replaced.decided, [["key", { kind: "decline" }]]);
});

test("denying declines with the parent's feedback without asking the user", async () => {
  const denied = child([{ requestKey: "key", subject: command }]);
  await resolveSubagentApproval(denied.input, { kind: "deny", feedback: "Use the sandboxed test command." }, signal);
  assert.deepEqual(denied.asked, []);
  assert.deepEqual(denied.decided, [["key", { kind: "decline", feedback: "Use the sandboxed test command." }]]);
});

test("no request, or several, decides nothing", async () => {
  for (const pending of [[], [{ requestKey: "a", subject: command }, { requestKey: "b", subject: command }]]) {
    const target = child(pending);
    await assert.rejects(resolveSubagentApproval(target.input, { kind: "deny", feedback: null }, signal), /Marigold/u);
    assert.deepEqual([target.asked, target.decided], [[], []]);
  }
});
