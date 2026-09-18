/* Exports: none. Protect old/new wire compatibility without leaking composer settings. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceConfiguration, readVoiceModelSelection, VoiceConfigurationSchema } from "./voice-session-contract";

test("legacy profile payloads become independent model selections and encode neutral settings", () => {
  const legacy = VoiceConfigurationSchema.parse({ selection: {
    kind: "profile", profileId: "old-profile", settings: {
      harness: "codex", model: "chosen", agentPath: "library:agents/old.md", agentSource: "library",
      reasoningEffort: "high", serviceTier: "fast", contextWindowTokens: 123456,
    },
  } });
  const selection = readVoiceModelSelection(legacy);
  assert.deepEqual(selection, { harness: "codex", model: "chosen" });
  const wire = VoiceConfigurationSchema.parse(createVoiceConfiguration(selection));
  assert.equal(wire.selection?.kind, "custom");
  assert.deepEqual(wire.selection?.settings, {
    harness: "codex", model: "chosen", agentPath: null, agentSource: null,
    reasoningEffort: "none", serviceTier: null, contextWindowTokens: null,
  });
  assert.equal(readVoiceModelSelection(VoiceConfigurationSchema.parse(createVoiceConfiguration(null))), null);
});
