/* No production exports. Tests protect model grouping and one-week usage selection. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchModelOption } from "workbench-shared/types";
import { groupThreadModels } from "./thread-model-groups";

const model = (id: string) => ({ id, displayName: id, policyState: null }) as WorkbenchModelOption;

test("groups OpenCode inner providers without losing unrecognised providers", () => {
  const groups = groupThreadModels({
    catalogues: {
      opencode: [
        model("zeta/one"), model("opencode-go/two"), model("alpha/three"),
        model("opencode-zen/four"),
      ],
      codex: [model("codex-model")],
      claude: [model("claude-model")],
    },
    favourites: [], allowedHarnesses: ["opencode", "codex", "claude"], now: 10,
  });
  assert.deepEqual(groups.map(group => group.id), [
    "provider:claude", "provider:codex", "provider:opencode:alpha",
    "provider:opencode:opencode-go", "provider:opencode:opencode-zen", "provider:opencode:zeta",
  ]);
  assert.deepEqual(groups.map(group => group.models.map(entry => entry.model.id)), [
    ["claude-model"], ["codex-model"], ["alpha/three"], ["opencode-go/two"],
    ["opencode-zen/four"], ["zeta/one"],
  ]);
});

test("recent means accepted use within a week and excludes favourites", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const groups = groupThreadModels({
    catalogues: { codex: [
      { ...model("favourite"), lastUsedAt: now },
      { ...model("recent"), lastUsedAt: now - 7 * 24 * 60 * 60 * 1000 },
      { ...model("old"), lastUsedAt: now - 7 * 24 * 60 * 60 * 1000 - 1 },
      { ...model("disabled"), policyState: "disabled", lastUsedAt: now },
    ] },
    favourites: [{ harness: "codex", modelId: "favourite" }],
    allowedHarnesses: ["codex"], now,
  });
  assert.deepEqual(groups[0]?.models.map(entry => entry.model.id), ["favourite"]);
  assert.deepEqual(groups[1]?.models.map(entry => entry.model.id), ["recent"]);
  assert.deepEqual(groups[2]?.models.map(entry => entry.model.id), ["favourite", "recent", "old"]);
});

test("empty favourites and recent do not occupy navigation sections", () => {
  const groups = groupThreadModels({
    catalogues: { codex: [{ ...model("visible"), lastUsedAt: 0 }] },
    favourites: [{ harness: "claude", modelId: "unavailable" }],
    allowedHarnesses: ["codex"],
    now: 8 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(groups.map(group => group.id), ["provider:codex"]);
});
