/*
 * Exports:
 * - No production exports; tests protect selected skill rendering and failure boundaries.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchSkillController from "./WorkbenchSkillController";

test("selected skill returns only filtered body with relative imports", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-skill-");
  try {
    const relativePath = ".agents/skills/spark/SKILL.md";
    const skillPath = path.join(temporary.path, relativePath);
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, [
      "---",
      "name: spark",
      "description: Use for sparkle work.",
      "---",
      "<!-- hidden note -->",
      "<harness:opencode>",
      "call <tool id=\"rg\" />.",
      "{./notes.md}",
      "</harness:opencode>",
      "<model:gpt-other>wrong model</model:gpt-other>",
      "<available:browse-raw>raw browse enabled</available:browse-raw>",
    ].join("\n"));
    await fs.writeFile(path.join(path.dirname(skillPath), "notes.md"), "imported instructions\n");
    let browseRawEnabled = false;
    const controller = new WorkbenchSkillController({
      listSkills: async () => [{
        content: "unused catalogue body",
        description: "Use for sparkle work.",
        name: "spark",
        path: skillPath,
        relativePath,
      }],
      readInstructionTools: async () => [{ id: "rg", codeModeEligible: true }],
      readLocalCapabilities: async () => ({ browseRawCommandsEnabled: browseRawEnabled }),
    });
    const response = await controller.execute({
      cwd: temporary.path, harness: "opencode", model: "gpt-test",
      name: "spark", threadId: "thread",
    }, new AbortController().signal);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /call `tools\.wb\.rg`/u);
    assert.match(body, /imported instructions/u);
    assert.doesNotMatch(body, /name: spark|hidden note|wrong model|raw browse enabled|<skill/u);
    browseRawEnabled = true;
    const withBrowse = await controller.execute({
      cwd: temporary.path, harness: "opencode", model: "gpt-test",
      name: "spark", threadId: "thread",
    }, new AbortController().signal);
    assert.match(await withBrowse.text(), /raw browse enabled/u);
  } finally {
    await temporary.dispose();
  }
});

test("missing skill and escaping import fail rather than returning partial instructions", async t => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-skill-fail-");
  try {
    const relativePath = ".agents/skills/spark/SKILL.md";
    const skillPath = path.join(temporary.path, relativePath);
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, "---\nname: spark\n---\n{./../../../../outside.md}\n");
    const controller = new WorkbenchSkillController({
      listSkills: async () => [{
        content: "unused catalogue body", description: "", name: "spark",
        path: skillPath, relativePath,
      }],
      readInstructionTools: async () => [],
      readLocalCapabilities: async () => ({ browseRawCommandsEnabled: false }),
    });
    const base = {
      cwd: temporary.path, harness: "codex" as const, model: "gpt-test",
      threadId: "thread",
    };
    assert.equal((await controller.execute({ ...base, name: "missing" }, new AbortController().signal)).status, 404);
    assert.equal((await controller.execute({ ...base, model: "", name: "spark" }, new AbortController().signal)).status, 409);
    const escaping = await controller.execute({ ...base, name: "spark" }, new AbortController().signal);
    assert.notEqual(escaping.status, 200);
    assert.doesNotMatch(await escaping.text(), /outside|unused catalogue body/u);
    assert.equal(warnings.length, 1);
  } finally {
    await temporary.dispose();
  }
});
