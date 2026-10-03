/*
 * No production exports. Tests protect the single live approval owner: presentation, saved rules, decisions, outcomes and cleanup.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchHarness } from "workbench-shared/types";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchApprovalDecision, WorkbenchApprovalOutcomeEntry, WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import { COMMAND_APPROVAL_CONFIRMATION } from "./lib/workbench/command-approval-prefix";
import WorkbenchApprovalController, { type WorkbenchApprovalHandoff } from "./WorkbenchApprovalController";

const threadId = WorkbenchThreadIdSchema.parse("11111111-1111-4111-8111-111111111111");
const turnId = WorkbenchTurnIdSchema.parse("22222222-2222-4222-8222-222222222222");
const projectId = ProjectIdSchema.parse("33333333-3333-4333-8333-333333333333");
const prefix = ["pnpm", "run", "typecheck"];

function command(overrides: Partial<Extract<WorkbenchApprovalSubject, { kind: "command" }>> = {}): WorkbenchApprovalSubject {
  return {
    kind: "command", command: "pwsh -NoProfile -Command 'pnpm run typecheck'", cwd: "C:/repo", commandActions: [],
    justification: "Run checks.", networkTarget: null, rememberable: true, suggestedPrefixes: [], ...overrides,
  };
}

function harness(options: { saved?: boolean; failSave?: boolean; deliverable?: boolean; handoff?: WorkbenchApprovalHandoff } = {}) {
  const events: string[] = [];
  const delivered: WorkbenchApprovalDecision[] = [];
  const outcomes: WorkbenchApprovalOutcomeEntry[] = [];
  const saves: string[][] = [];
  const controller = new WorkbenchApprovalController({
    broadcast: (_harness: WorkbenchHarness, notification) => { events.push(notification.method); },
    collectAnswerContext: async () => { events.push("context"); },
    commandApprovals: {
      match: async () => options.saved ? { id: "6ec53578-a9ef-44df-8f4b-bb62f2d8ae4a", projectId, workdir: "c:/repo", prefix } : null,
      save: async (_project, _workdir, selected) => {
        if (options.failSave) throw new Error("permission store unavailable");
        saves.push([...selected]);
        return { id: "6ec53578-a9ef-44df-8f4b-bb62f2d8ae4a", projectId, workdir: "c:/repo", prefix: [...selected] };
      },
    },
    deliver: async (_harness, input) => {
      events.push("deliver");
      delivered.push(input.decision);
      return options.deliverable ?? true;
    },
    logError: () => undefined,
    observeLifecycle: async (_harness, _thread, event) => {
      events.push(`${event.kind}${"answered" in event && event.answered ? ":answered" : ""}`);
    },
    recordOutcome: async entry => { outcomes.push(entry); },
    resolveProject: async () => projectId,
  }, options.handoff);
  const open = (requestKey: string, subject = command()) => controller.open({
    harness: "claude", threadId, turnId, itemId: `item-${requestKey}`, requestKey, subject, allowSession: false,
  });
  const choose = (requestKey: string, answers: string[]) => controller.respond({
    threadId, requestKey, response: { answers: { decision: { answers } } },
  });
  const options_ = (requestKey: string) => controller.list().find(pending => pending.requestKey === requestKey)
    ?.request.questions[0]?.options.map(option => option.label) ?? [];
  return { controller, events, delivered, outcomes, saves, open, choose, options: options_ };
}

test("a shown approval carries command context, offers one-shot and remember choices, and records its answered outcome", async () => {
  const h = harness();
  assert.deepEqual(await h.open("first", command({ suggestedPrefixes: [prefix] })), { kind: "shown" });
  assert.deepEqual(h.events, ["questionnaire/requested", "pendingInput"]);
  const pending = h.controller.list()[0]!;
  assert.equal(pending.request.approval?.command?.command, "pwsh -NoProfile -Command 'pnpm run typecheck'");
  assert.equal(pending.itemId, "item-first");
  assert.equal(h.options("first").includes("Allow for session"), false);
  assert.ok(h.options("first").some(label => label.includes("Always allow")));
  await assert.rejects(h.choose("first", []), /exactly one/u);
  await assert.rejects(h.choose("first", ["Allow once", "Decline"]), /exactly one/u);
  await h.choose("first", ["Allow once"]);
  assert.deepEqual(h.delivered, [{ kind: "allowOnce" }]);
  assert.deepEqual(h.outcomes.map(({ itemId, outcome }) => [itemId, outcome]), [["item-first", "approved"]]);
  assert.deepEqual(h.events.slice(2), ["context", "deliver", "questionnaire/resolved", "inputResolved:answered"]);
  assert.deepEqual(h.controller.list(), []);
  await assert.rejects(h.choose("first", ["Allow once"]), /no longer pending/u);
});

test("remembering a prefix saves before delivering, and a failed save keeps the question answerable", async () => {
  const failing = harness({ failSave: true });
  await failing.open("first", command({ suggestedPrefixes: [prefix] }));
  const always = failing.options("first").find(label => label.includes("Always allow"))!;
  await assert.rejects(failing.choose("first", [always]), /permission store unavailable/u);
  assert.deepEqual(failing.delivered, []);
  assert.equal(failing.controller.list().length, 1);

  const h = harness();
  await h.open("first", command({ suggestedPrefixes: [prefix] }));
  await h.choose("first", [h.options("first").find(label => label.includes("Always allow"))!]);
  assert.deepEqual(h.saves, [prefix]);
  assert.deepEqual(h.delivered, [{ kind: "allowOnce" }]);
});

test("saved rules decide without asking: confirmed runs auto-approve, unconfirmed ones refuse with feedback", async () => {
  const confirmed = harness({ saved: true });
  assert.deepEqual(
    await confirmed.open("first", command({ justification: `Run checks.\n${COMMAND_APPROVAL_CONFIRMATION}` })),
    { kind: "decided", decision: { kind: "allowOnce" } },
  );
  assert.deepEqual(confirmed.outcomes.map(({ outcome }) => outcome), ["autoApproved"]);
  assert.deepEqual(confirmed.events, [], "nothing is shown for an automatic decision");

  const unconfirmed = harness({ saved: true });
  const result = await unconfirmed.open("first");
  assert.ok(result.kind === "decided" && result.decision.kind === "decline" && result.decision.feedback?.includes(COMMAND_APPROVAL_CONFIRMATION));
  assert.deepEqual(unconfirmed.outcomes, []);

  const unrememberable = harness({ saved: true });
  assert.deepEqual(await unrememberable.open("first", command({ rememberable: false })), { kind: "shown" });
});

test("closing, failed delivery and disposal retract the question; re-opening a held request is idempotent", async () => {
  const h = harness();
  await h.open("held");
  assert.deepEqual(await h.open("held"), { kind: "shown" });
  assert.equal(h.events.filter(event => event === "questionnaire/requested").length, 1);
  h.controller.close("claude", "held");
  await Promise.resolve();
  assert.deepEqual(h.events.slice(-2), ["questionnaire/resolved", "inputResolved"]);
  await assert.rejects(h.choose("held", ["Decline"]), /no longer pending/u);

  const gone = harness({ deliverable: false });
  await gone.open("first");
  await assert.rejects(gone.choose("first", ["Decline"]), /no longer pending/u);
  assert.deepEqual(gone.outcomes, []);
  assert.ok(gone.events.includes("questionnaire/resolved"));
  assert.deepEqual(gone.controller.list(), []);

  const disposed = harness();
  await disposed.open("first");
  disposed.controller.dispose();
  assert.equal(disposed.events.at(-1), "questionnaire/resolved");
  assert.deepEqual(disposed.controller.list(), []);
});

async function shownHostedRequest(h: ReturnType<typeof harness>, signal = new AbortController().signal) {
  const decision = h.controller.request({ harness: "claude", threadId, turnId, itemId: "item-hosted", subject: command() }, signal);
  for (let attempt = 0; attempt < 20 && !h.controller.list().length; attempt++) await Promise.resolve();
  const shown = h.controller.list()[0];
  assert.ok(shown, "the hosted approval was not shown");
  return { decision, requestKey: shown.requestKey };
}

test("hosted waits settle in-process on response, and cancellation or shutdown rejects and retracts them", async () => {
  const h = harness();
  const answered = await shownHostedRequest(h);
  await h.choose(answered.requestKey, ["Allow once"]);
  assert.deepEqual(await answered.decision, { kind: "allowOnce" });
  assert.equal(h.events.includes("deliver"), false, "hosted decisions never route through a provider");

  const abort = new AbortController();
  const cancelled = await shownHostedRequest(h, abort.signal);
  abort.abort(new Error("tool call cancelled"));
  await assert.rejects(cancelled.decision, /tool call cancelled/u);
  assert.deepEqual(h.controller.list(), []);
  assert.deepEqual(h.events.slice(-2), ["questionnaire/resolved", "inputResolved"]);

  const stopping = await shownHostedRequest(h);
  h.controller.dispose();
  await assert.rejects(stopping.decision, /stopped/u);
});

test("a core reload hands pending approvals to the committed successor without retracting them", async () => {
  const previous = harness();
  const hosted = await shownHostedRequest(previous);
  await previous.open("native");

  // A discarded reload candidate never takes over.
  const discarded = harness({ handoff: previous.controller.captureReloadState() });
  discarded.controller.dispose();
  assert.equal(previous.controller.list().length, 2);

  const successor = harness({ handoff: previous.controller.captureReloadState() });
  successor.controller.activate();
  previous.controller.dispose();
  assert.equal(previous.events.includes("questionnaire/resolved"), false, "the retiring generation retracts nothing");
  assert.deepEqual(await successor.open("native"), { kind: "shown" }, "a provider re-open after reload stays idempotent");
  assert.deepEqual(successor.events, []);

  await successor.choose(hosted.requestKey, ["Decline"]);
  assert.deepEqual(await hosted.decision, { kind: "decline" });
  await successor.choose("native", ["Allow once"]);
  assert.deepEqual(successor.delivered, [{ kind: "allowOnce" }]);
});
