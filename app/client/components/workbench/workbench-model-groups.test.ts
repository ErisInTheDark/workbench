/* No production exports. Tests protect model grouping and one-week usage selection. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchModelOption } from "workbench-shared/types";
import { groupWorkbenchModels } from "./workbench-model-groups";

const model = (id: string) => ({ id, displayName: id, policyState: null }) as WorkbenchModelOption;

test("groups OpenCode inner providers without losing unrecognised providers", () => {
  const groups = groupWorkbenchModels({
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
  const groups = groupWorkbenchModels({
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
  const groups = groupWorkbenchModels({
    catalogues: { codex: [{ ...model("visible"), lastUsedAt: 0 }] },
    favourites: [{ harness: "claude", modelId: "unavailable" }],
    allowedHarnesses: ["codex"],
    now: 8 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(groups.map(group => group.id), ["provider:codex"]);
});

test("alias favourites resolve to one canonical model without duplicating recent or provider choices", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const groups = groupWorkbenchModels({
    catalogues: { claude: [{
      ...model("claude-sonnet-4-6"), aliases: ["sonnet"], lastUsedAt: now,
    }] },
    favourites: [{ harness: "claude", modelId: "sonnet" }],
    allowedHarnesses: ["claude"], now,
  });
  assert.deepEqual(groups.map(group => group.kind), ["favourites", "provider"]);
  assert.deepEqual(groups.map(group => group.models.map(entry => entry.model.id)), [
    ["claude-sonnet-4-6"], ["claude-sonnet-4-6"],
  ]);
});

test("drag order puts newest special models lowest and sorts provider models by name", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const groups = groupWorkbenchModels({
    catalogues: { codex: [
      { ...model("zeta"), displayName: "Zeta", lastUsedAt: now - 1_000 },
      { ...model("alpha"), displayName: "Alpha", lastUsedAt: now - 3_000 },
      { ...model("middle"), displayName: "Middle", lastUsedAt: now - 2_000 },
      { ...model("beta"), displayName: "Beta", lastUsedAt: now - 4_000 },
    ] },
    favourites: [
      { harness: "codex", modelId: "zeta" },
      { harness: "codex", modelId: "beta" },
    ],
    allowedHarnesses: ["codex"], now, order: "drag",
  });
  assert.deepEqual(groups.map(group => group.id), ["provider:codex", "recent", "favourites"]);
  assert.deepEqual(groups.map(group => group.models.map(entry => entry.model.id)), [
    ["alpha", "beta", "middle", "zeta"],
    ["alpha", "middle"],
    ["beta", "zeta"],
  ]);
});
