/*
 * No production exports. Tests protect the request_user_input input contract: uncapped options, repairable question identity, and strict rejection of unusable input. Keywords: questionnaire, schema, options, test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { WorkbenchRequestUserInputSchema } from "./questionnaire-command-definition";

test("questionnaire input accepts more than three options", () => {
  const parsed = WorkbenchRequestUserInputSchema.parse({
    questions: [{
      id: "route",
      header: "route",
      question: "How should the agent proceed?",
      options: [
        { label: "approve", description: "" },
        { label: "revise", description: "" },
        { label: "more inspection", description: "" },
        { label: "another route", description: "" },
      ],
    }],
  });
  assert.equal(parsed.questions[0]?.options.length, 4);
});

test("questionnaire input accepts missing question identity for repair", () => {
  const parsed = WorkbenchRequestUserInputSchema.parse({
    questions: [{ question: "How should the agent proceed?", options: [] }],
  });
  assert.equal(parsed.questions[0]?.question, "How should the agent proceed?");
});

test("questionnaire input still rejects unusable or unknown fields", () => {
  assert.throws(() => WorkbenchRequestUserInputSchema.parse({ questions: [{ id: "a", header: "a", question: "  ", options: [] }] }));
  assert.throws(() => WorkbenchRequestUserInputSchema.parse({ questions: [{ id: "a", header: "a", question: "go?", options: [] }], summary: "nope" }));
  assert.throws(() => WorkbenchRequestUserInputSchema.parse({ questions: [] }));
});
