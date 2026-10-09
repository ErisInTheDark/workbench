/* No production exports. Protect per-tool prompt cost: served spec text, evenly split docs, provider averaging, and always-on sources only. */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchToolCatalogueTokens from "./WorkbenchToolCatalogueTokens.ts";

// One token per character keeps expected figures readable.
const count = (text: string) => text.length;

test("tool prompt cost averages served specs and evenly split docs across providers", async () => {
  const docs = [
    "<docs tools=\"alpha beta\">",
    "1234",
    "</docs>",
    "<docs tools=\"alpha\">",
    "<harness:claude>",
    "cc",
    "</harness:claude>",
    "</docs>",
  ].join("\n");
  const cost = new WorkbenchToolCatalogueTokens({
    count,
    harnesses: ["claude", "codex"],
    readInstructionSources: async () => [
      { relativePath: "wb/mechanics/tools.md", content: docs },
      // Skill bodies and templates are not always-on prompt.
      { relativePath: "skills/builtin/browse/SKILL.md", content: "<docs tools=\"alpha\">\nskill body\n</docs>" },
      { relativePath: "AGENTS.template.md", content: "<docs tools=\"alpha\">\ntemplate\n</docs>" },
    ],
    readInstructionTools: async () => [{ id: "alpha", codeModeEligible: true }, { id: "beta", codeModeEligible: true }],
    readToolSpecs: async (harness) => harness === "claude"
      ? [{ name: "alpha", description: "d", inputSchema: {} }, { name: "beta", description: "", inputSchema: {} }]
      : [{ name: "alpha", description: "d", inputSchema: {} }],
  });
  const result = await cost.read();
  // alpha spec "alpha\nd\n{}" = 10 on both; beta "beta\n\n{}" = 8 on claude only.
  assert.deepEqual(result.tools.get("alpha"), { specTokens: 10, docsTokens: (2 + 2 + 2) / 2 });
  assert.deepEqual(result.tools.get("beta"), { specTokens: 4, docsTokens: 2 });
  assert.equal(result.specTokens, 14);
  assert.equal(result.docsTokens, 5);
});
