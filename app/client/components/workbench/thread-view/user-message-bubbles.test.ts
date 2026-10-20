/*
 * No exports. Tests protect how one user message splits into leading references and `=====`-separated bubbles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createComposerReferenceMessage } from "workbench-shared/workbench/thread/composer-reference";
import type { WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";
import { layoutUserMessageBubbles } from "./user-message-bubbles.ts";

const text = (value: string) => ({ type: "text", text: value }) as UserInput;
const image = { type: "image", url: "data:image/png;base64,AA==" } as UserInput;
const texts = (bubbles: UserInput[][]) => bubbles.map((bubble) => bubble.map((item) => item.type === "text" ? item.text : item.type));
const bubbleTexts = (input: UserInput[]) => texts(layoutUserMessageBubbles(input).bubbles);
const todoMessage = (message: string) => createComposerReferenceMessage(
  [{ kind: "todo", id: 4, required: true, createdAt: 1_000, text: "fix the thing" }],
  message,
);

test("separator lines of five or more = split a message into bubbles", () => {
  assert.deepEqual(bubbleTexts([text("## Bug\nbroken\n\n=====\n\nplease fix\n  ========  \nthanks")]), [
    ["## Bug\nbroken"], ["please fix"], ["thanks"],
  ]);
});

test("shorter or inline runs stay text, empty segments vanish, and images keep their place", () => {
  assert.deepEqual(bubbleTexts([text("a ===== b\n====\nc")]), [["a ===== b\n====\nc"]]);
  assert.deepEqual(bubbleTexts([text("=====\nfirst\n=====\n=====")]), [["first"]]);
  assert.deepEqual(bubbleTexts([text("before\n=====\nafter"), image]), [["before"], ["after", "image"]]);
  assert.deepEqual(bubbleTexts([text("  ")]), []);
});

test("a reference-only message still gets one bubble to carry its pills and actions", () => {
  const layout = layoutUserMessageBubbles([text(todoMessage(""))]);
  assert.deepEqual(layout.references.map((reference) => reference.kind), ["todo"]);
  assert.deepEqual(texts(layout.bubbles), [[]]);
});

test("leading references split off before the user's own words are bubbled", () => {
  const layout = layoutUserMessageBubbles([text(todoMessage("look\n=====\nhere"))]);
  assert.equal(layout.references.length, 1);
  assert.deepEqual(texts(layout.bubbles), [["look"], ["here"]]);
});
