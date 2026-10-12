/*
 * No production exports. Tests protect caret-line anchoring and composer-width popup layout.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getInlineMentionSuggestionsPortalStyle } from "./plaintext-editable-suggestion-geometry";

const fieldRect = { bottom: 900, left: 20, top: 100, width: 600 };
const caretRect = { bottom: 428, left: 180, top: 404, width: 0 };

test("suggestions open above or below the active caret line in a tall composer", () => {
  assert.equal(
    getInlineMentionSuggestionsPortalStyle(fieldRect, caretRect, "above", 1000).top,
    396,
  );
  assert.equal(
    getInlineMentionSuggestionsPortalStyle(fieldRect, caretRect, "below", 1000).top,
    436,
  );
});

test("suggestions retain composer width and clamp horizontally to the viewport", () => {
  assert.deepEqual(
    getInlineMentionSuggestionsPortalStyle(
      { ...fieldRect, left: -40, width: 1200 },
      caretRect,
      "above",
      1000,
    ),
    {
      left: 8,
      top: 396,
      transform: "translateY(-100%)",
      width: 984,
    },
  );
});
