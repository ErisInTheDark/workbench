/*
 * No production exports. Regression wards protect source-Markdown bubble copying, attachment exclusion, renderer coverage, and bounded feedback lifecycle. Keywords: thread, bubble, copy, markdown, lifecycle, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { withWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { createWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import { WORKBENCH_APPROVAL_NOTE_TAG_WRAPPER } from "workbench-shared/workbench/thread/thread-user-input-requests";
import {
  createBubbleCopyFeedbackController,
  getUserMessageCopyMarkdown,
  type BubbleCopyFeedbackNode,
} from "./bubble-copy";
import ThreadDynamicToolCallItem from "./ThreadDynamicToolCallItem";
import { ThreadTurnDetails } from "./thread-view-items";

type DynamicItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;
type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;

function createFeedbackNode() {
  const attributes: Record<string, string> = {};
  const node: BubbleCopyFeedbackNode = {
    setAttribute(name, value) {
      attributes[name] = value;
    },
    title: "",
  };
  return { attributes, node };
}

function createUserMessage(id: string, text: string): UserMessageItem {
  return {
    clientId: null,
    content: [{ text, text_elements: [], type: "text" }],
    id,
    type: "userMessage",
  };
}

function renderUserItems(items: UserMessageItem[]) {
  const turn: Turn = {
    completedAt: null,
    durationMs: null,
    error: null,
    id: "copy-turn",
    items,
    itemsView: "full",
    startedAt: null,
    status: "inProgress",
  };
  return renderToStaticMarkup(createElement(ThreadTurnDetails, {
    threadId: "copy-thread",
    turn,
  }));
}

test("user message copy Markdown preserves source syntax and excludes attachments", () => {
  const markdown = getUserMessageCopyMarkdown([
    { text: "  **bold** [target](https://example.com)  ", text_elements: [], type: "text" },
    { type: "image", url: "data:image/png;base64,ignored" },
    { name: "ignored-skill", path: "C:/skills/ignored", type: "skill" },
    { text: "`second`", text_elements: [], type: "text" },
    { name: "ignored-mention", path: "C:/files/ignored.ts", type: "mention" },
  ]);

  assert.equal(markdown, "  **bold** [target](https://example.com)  \n\n`second`");
  assert.equal(getUserMessageCopyMarkdown([{ type: "localImage", path: "C:/images/only.png" }]), "");
});

test("ordinary user messages and pending inputs render source-Markdown copy actions", () => {
  const html = renderUserItems([
    createUserMessage("prompt", "Original **prompt**"),
    withWorkbenchInputState(createUserMessage("792ed0f9-6f35-441b-abde-39a7a8ddcb67", "Pending *steer*"), { kind: "optimistic", placement: "steer", status: "pending" }),
    withWorkbenchInputState(createUserMessage("pending-initial", "Pending initial"), { kind: "optimistic", placement: "initial", status: "pending" }),
    withWorkbenchInputState(createUserMessage("admitted-initial", "Admitted initial"), { kind: "optimistic", placement: "initial", status: "sent" }),
  ]);

  assert.equal(html.match(/data-thread-bubble-copy-button="true"/gu)?.length, 4, html);
  assert.match(html, /data-thread-user-message-state="pending-steer"/u);
  assert.equal(html.match(/data-thread-user-message-state="pending-initial"/gu)?.length, 2, html);
  assert.equal(html.match(/data-workbench-spinning-border="true"/gu)?.length, 3, html);
});

test("same-state textual steers render one merged Markdown bubble and copy action", () => {
  const html = renderUserItems([
    withWorkbenchInputState(createUserMessage("steer-a", "First **steer**"), { kind: "steer", status: "sent" }),
    withWorkbenchInputState(createUserMessage("steer-b", "Second *steer*"), { kind: "steer", status: "sent" }),
  ]);

  assert.equal(html.match(/data-thread-bubble-copy-button="true"/gu)?.length, 1, html);
  assert.match(html, /<p\b[^>]*>First <strong>steer<\/strong><\/p><p\b[^>]*>Second <em>steer<\/em><\/p>/u);
});

test("different-state textual steers remain separate bubbles", () => {
  const html = renderUserItems([
    withWorkbenchInputState(createUserMessage("sent", "Sent"), { kind: "steer", status: "sent" }),
    withWorkbenchInputState(createUserMessage("pending", "Pending"), { kind: "steer", status: "pending" }),
  ]);

  assert.equal(html.match(/data-thread-bubble-copy-button="true"/gu)?.length, 2, html);
});

test("approval-note metadata stays hidden from steer rendering and copy Markdown", () => {
  const wrapped = WORKBENCH_APPROVAL_NOTE_TAG_WRAPPER.wrap(
    "The requested cwd is wrong.",
    { type: "declined" },
  );
  const item = createUserMessage("approval-note", wrapped);
  const html = renderUserItems([item]);
  const displayInput = unwrapWorkbenchSteerDisplayInput(item.content);

  assert.match(html, /The requested cwd is wrong\./u);
  assert.doesNotMatch(html, /wb:run-outside-sandbox:note|type=&quot;declined&quot;/u);
  assert.equal(getUserMessageCopyMarkdown(displayInput), "The requested cwd is wrong.");
});

test("activated skill transport stays out of user rendering and copy Markdown", () => {
  const item = createUserMessage("activated-skill", "/iterate now");
  item.content.push(createWorkbenchActivatedSkillsInput(
    '<skill filename="C:/skills/iterate/SKILL.md" trigger="/iterate">\nSECRET SKILL BODY\n</skill>',
  ));
  const html = renderUserItems([item]);
  const displayInput = unwrapWorkbenchSteerDisplayInput(item.content);

  assert.doesNotMatch(html, /wb:activated-skills|SECRET SKILL BODY/u);
  assert.equal(getUserMessageCopyMarkdown(displayInput), "/iterate now");
});

test("image-only user messages do not render a copy action", () => {
  const item: UserMessageItem = {
    clientId: null,
    content: [{ type: "image", url: "data:image/png;base64,only" }],
    id: "image-only",
    type: "userMessage",
  };

  assert.doesNotMatch(renderUserItems([item]), /data-thread-bubble-copy-button/u);
});

test("recorded questionnaire answers render one source-Markdown copy action", () => {
  const item: DynamicItem = {
    arguments: {
      id: "questionnaire",
      questions: [{
        allowOther: false,
        header: "Choice",
        id: "choice",
        isSecret: false,
        options: [{ description: "Use **source**", label: "Yes" }],
        question: "Continue?",
      }],
      submitLabel: "Submit",
      summary: "",
      title: "Continue?",
    },
    contentItems: [{ text: JSON.stringify({ answers: { choice: { answers: ["Yes"] } } }), type: "inputText" }],
    durationMs: null,
    id: "questionnaire-response",
    namespace: null,
    status: "completed",
    success: true,
    tool: "workbench_request_user_input",
    type: "dynamicToolCall",
  };
  const html = renderToStaticMarkup(createElement(ThreadDynamicToolCallItem, { item }));

  assert.equal(html.match(/data-thread-bubble-copy-button="true"/gu)?.length, 1, html);
});

test("copy feedback writes exact Markdown and owns success, failure, and reset state", async () => {
  let nextHandle = 0;
  const scheduled = new Map<ReturnType<typeof setTimeout>, () => void>();
  const writes: string[] = [];
  const controller = createBubbleCopyFeedbackController({
    clearScheduled: (handle) => {
      scheduled.delete(handle);
    },
    schedule: (callback) => {
      const handle = ++nextHandle as unknown as ReturnType<typeof setTimeout>;
      scheduled.set(handle, callback);
      return handle;
    },
    writeText: async (text) => {
      writes.push(text);
      return true;
    },
  });
  const success = createFeedbackNode();
  const unregister = controller.register(success.node);
  const sourceMarkdown = "  **bold**\n\n[target](https://example.com)  ";

  assert.equal(await controller.copy(success.node, sourceMarkdown), true);
  assert.deepEqual(writes, [sourceMarkdown]);
  assert.equal(success.attributes["data-thread-bubble-copy-state"], "copied");
  assert.equal(success.attributes["aria-label"], "Copied message");
  const [resetSuccess] = scheduled.values();
  assert.ok(resetSuccess);
  scheduled.clear();
  resetSuccess();
  assert.equal(success.attributes["data-thread-bubble-copy-state"], "idle");
  assert.equal(success.attributes["aria-label"], "Copy message");
  unregister();

  const failed = createFeedbackNode();
  const failingController = createBubbleCopyFeedbackController({
    schedule: (callback) => {
      const handle = ++nextHandle as unknown as ReturnType<typeof setTimeout>;
      scheduled.set(handle, callback);
      return handle;
    },
    writeText: async () => false,
  });
  failingController.register(failed.node);
  assert.equal(await failingController.copy(failed.node, "failure"), false);
  assert.equal(failed.attributes["data-thread-bubble-copy-state"], "failed");
  assert.equal(failed.attributes["aria-label"], "Copy failed");
});

test("unregistering blocks a late clipboard result from updating feedback", async () => {
  let resolveWrite!: (didCopy: boolean) => void;
  let scheduled = false;
  const controller = createBubbleCopyFeedbackController({
    schedule: () => {
      scheduled = true;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    writeText: async () => await new Promise<boolean>((resolve) => {
      resolveWrite = resolve;
    }),
  });
  const feedback = createFeedbackNode();
  const unregister = controller.register(feedback.node);
  const copy = controller.copy(feedback.node, "**late**");

  unregister();
  assert.ok(resolveWrite);
  resolveWrite(true);
  assert.equal(await copy, false);
  assert.equal(feedback.attributes["data-thread-bubble-copy-state"], "idle");
  assert.equal(scheduled, false);
});
