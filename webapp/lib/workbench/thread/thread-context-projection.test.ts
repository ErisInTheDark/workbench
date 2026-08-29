/*
 * Exports:
 * - No production exports; Node tests cover native steer identity and canonical context position. Keywords: thread, context, steer, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload, WorkbenchThreadContextBundle } from "../../types.ts";
import { createWorkbenchActivatedSkillsInput } from "./thread-activated-skills.ts";
import { renderWorkbenchThreadContextPieceMarkdown } from "./thread-context-markdown.ts";
import { buildWorkbenchThreadContextPieces } from "./thread-context-projection.ts";
import { createWorkbenchQuestionnaireResponseInput, createWorkbenchThreadRecoveryInput } from "./thread-recovery-message.ts";

function thread(): ThreadPayload {
  return {
    agentNickname: null, agentPath: null, agentRole: null, browseResultEntries: [], createdAt: 1, cwd: "C:/repo",
    forkedFromId: null, harness: "codex", id: "thread", isDraft: false, model: null, name: null, path: null, preview: "",
    reasoningEffort: null, serviceTier: null, source: "codex", status: "idle", tokenUsage: null, turnHistory: [], updatedAt: 1,
    turns: [{ completedAt: 3, durationMs: 2, error: null, id: "turn", items: [
      { clientId: "native-a", content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical-a", type: "userMessage" },
      { clientId: "native-b", content: [{ text: "same", text_elements: [], type: "text" }], id: "canonical-b", type: "userMessage" },
    ], itemsView: "full", startedAt: 1, status: "completed" }],
  };
}

test("native steer suppresses and positions only its exact canonical message", () => {
  const bundle: WorkbenchThreadContextBundle = {
    browseResultEntries: [], questionnaireEntries: [], thread: thread(), steerEntries: [{
      attemptedAt: 2, canonicalItemId: null, clientUserMessageId: "native-a", dispatchSequence: 0,
      entryKey: "turn-steer-client:native-a", error: null, input: [{ text: "same", text_elements: [], type: "text" }],
      requestId: "1", resolvedAt: 2, status: "sent", threadId: "thread", turnId: "turn",
    }],
  };
  const pieces = buildWorkbenchThreadContextPieces(bundle);
  assert.deepEqual(pieces.map((piece) => [piece.kind, piece.itemId]), [["userSteer", null], ["userMessage", "canonical-b"]]);
  assert.ok(pieces[0]!.sortKey < pieces[1]!.sortKey);
});

test("exact Workbench resume and questionnaire-response steers stay out of projected context", () => {
  const source = thread();
  source.turns[0]!.items.push(
    { clientId: null, content: createWorkbenchThreadRecoveryInput(), id: "resume", type: "userMessage" },
    { clientId: null, content: createWorkbenchQuestionnaireResponseInput({ answers: { route: { answers: ["approved"] } } }), id: "response", type: "userMessage" },
  );
  const bundle: WorkbenchThreadContextBundle = {
    browseResultEntries: [],
    questionnaireEntries: [],
    steerEntries: [],
    thread: source,
  };
  assert.deepEqual(buildWorkbenchThreadContextPieces(bundle).map((piece) => piece.itemId), ["canonical-a", "canonical-b"]);
});

test("activated skill transport is stripped and hidden-only records are omitted", () => {
  const source = thread();
  const activated = createWorkbenchActivatedSkillsInput(
    '<skill filename="C:/skills/iterate/SKILL.md" trigger="/iterate">\nSECRET SKILL BODY\n</skill>',
  );
  source.turns[0]!.items.push({
    clientId: null,
    content: [{ text: "/iterate now", text_elements: [], type: "text" }, activated],
    id: "activated-message",
    type: "userMessage",
  });
  const bundle: WorkbenchThreadContextBundle = {
    browseResultEntries: [],
    questionnaireEntries: [],
    steerEntries: [{
      attemptedAt: 4,
      canonicalItemId: null,
      clientUserMessageId: null,
      dispatchSequence: null,
      entryKey: "activated-only",
      error: null,
      input: [activated],
      requestId: "activated-only",
      resolvedAt: 5,
      status: "sent",
      threadId: "thread",
      turnId: "turn",
    }],
    thread: source,
  };
  const pieces = buildWorkbenchThreadContextPieces(bundle);
  const activatedMessage = pieces.find((piece) => piece.itemId === "activated-message");

  assert.equal(pieces.some((piece) => piece.kind === "userSteer"), false);
  assert.equal(
    activatedMessage ? renderWorkbenchThreadContextPieceMarkdown(activatedMessage) : null,
    "/iterate now",
  );
});

test("native client identity still correlates after a canonical item id alias changes", () => {
  const bundle: WorkbenchThreadContextBundle = {
    browseResultEntries: [], questionnaireEntries: [], thread: thread(), steerEntries: [{
      attemptedAt: 2, canonicalItemId: "stale-alias", clientUserMessageId: "native-a", dispatchSequence: 0,
      entryKey: "turn-steer-client:native-a", error: null, input: [{ text: "same", text_elements: [], type: "text" }],
      requestId: "1", resolvedAt: 2, status: "sent", threadId: "thread", turnId: "turn",
    }],
  };
  const pieces = buildWorkbenchThreadContextPieces(bundle);
  assert.deepEqual(pieces.map((piece) => [piece.kind, piece.itemId]), [["userSteer", "stale-alias"], ["userMessage", "canonical-b"]]);
});

test("pending native history cannot steal an equal-content canonical message", () => {
  const bundle: WorkbenchThreadContextBundle = {
    browseResultEntries: [], questionnaireEntries: [], thread: thread(), steerEntries: [{
      attemptedAt: 4, canonicalItemId: null, clientUserMessageId: "not-present", dispatchSequence: 0,
      entryKey: "turn-steer-client:not-present", error: null, input: [{ text: "same", text_elements: [], type: "text" }],
      requestId: "3", resolvedAt: null, status: "pending", threadId: "thread", turnId: "turn",
    }],
  };
  assert.deepEqual(buildWorkbenchThreadContextPieces(bundle).map((piece) => [piece.kind, piece.itemId]), [
    ["userMessage", "canonical-a"],
    ["userMessage", "canonical-b"],
    ["userSteer", null],
  ]);
});

test("legacy identity-free history retains content fallback", () => {
  const bundle: WorkbenchThreadContextBundle = {
    browseResultEntries: [], questionnaireEntries: [], thread: thread(), steerEntries: [{
      attemptedAt: 2, canonicalItemId: null, clientUserMessageId: null, dispatchSequence: null,
      entryKey: "legacy", error: null, input: [{ text: "same", text_elements: [], type: "text" }],
      requestId: "4", resolvedAt: 3, status: "sent", threadId: "thread", turnId: "turn",
    }],
  };
  assert.deepEqual(buildWorkbenchThreadContextPieces(bundle).map((piece) => piece.kind), ["userSteer"]);
});

test("canonical item id is stronger than equal-content neighbors", () => {
  const bundle: WorkbenchThreadContextBundle = {
    browseResultEntries: [], questionnaireEntries: [], thread: thread(), steerEntries: [{
      attemptedAt: 2, canonicalItemId: "canonical-b", clientUserMessageId: "stale-client", dispatchSequence: 0,
      entryKey: "turn-steer-client:stale-client", error: null, input: [{ text: "same", text_elements: [], type: "text" }],
      requestId: "5", resolvedAt: 3, status: "sent", threadId: "thread", turnId: "turn",
    }],
  };
  assert.deepEqual(buildWorkbenchThreadContextPieces(bundle).map((piece) => [piece.kind, piece.itemId]), [
    ["userMessage", "canonical-a"],
    ["userSteer", "canonical-b"],
  ]);
});

test("native client identity positions a steer when canonical item id is absent", () => {
  const bundle: WorkbenchThreadContextBundle = {
    browseResultEntries: [], questionnaireEntries: [], thread: thread(), steerEntries: [{
      attemptedAt: 2, canonicalItemId: null, clientUserMessageId: "native-b", dispatchSequence: 0,
      entryKey: "turn-steer-client:native-b", error: null, input: [{ text: "same", text_elements: [], type: "text" }],
      requestId: "6", resolvedAt: 3, status: "sent", threadId: "thread", turnId: "turn",
    }],
  };
  assert.deepEqual(buildWorkbenchThreadContextPieces(bundle).map((piece) => [piece.kind, piece.itemId]), [
    ["userMessage", "canonical-a"],
    ["userSteer", null],
  ]);
});
