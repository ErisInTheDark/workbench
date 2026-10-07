/*
 * No exports. Tests protect how `=====` separator lines split one user message into bubbles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchUserInput as UserInput } from "workbench-shared/workbench/provider/provider-input";
import { splitUserMessageBubbles } from "./user-message-bubbles.ts";

const text = (value: string) => ({ type: "text", text: value }) as UserInput;
const image = { type: "image", url: "data:image/png;base64,AA==" } as UserInput;
const texts = (bubbles: UserInput[][]) => bubbles.map((bubble) => bubble.map((item) => item.type === "text" ? item.text : item.type));

test("separator lines of five or more = split a message into bubbles", () => {
  assert.deepEqual(texts(splitUserMessageBubbles([text("## Bug\nbroken\n\n=====\n\nplease fix\n  ========  \nthanks")])), [
    ["## Bug\nbroken"], ["please fix"], ["thanks"],
  ]);
});

test("shorter or inline runs stay text, empty segments vanish, and images keep their place", () => {
  assert.deepEqual(texts(splitUserMessageBubbles([text("a ===== b\n====\nc")])), [["a ===== b\n====\nc"]]);
  assert.deepEqual(texts(splitUserMessageBubbles([text("=====\nfirst\n=====\n=====")])), [["first"]]);
  assert.deepEqual(texts(splitUserMessageBubbles([text("before\n=====\nafter"), image])), [["before"], ["after", "image"]]);
});
