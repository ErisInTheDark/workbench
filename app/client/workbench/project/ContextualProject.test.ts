/*
 * No production exports. Tests protect the contextual project's identity key and its answers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import ContextualProject from "./ContextualProject";

const facts = () => ({
  cwd: "C:/repo/app",
  filePaths: ["src/a.ts", "src/b.ts"],
  id: "project",
  rootPath: "C:/repo",
  skills: [{ description: "", name: "react", path: "C:/skills/react/SKILL.md" }],
  workspaceRoots: [{ id: "root", rootPath: "C:/repo" }],
});

test("re-provided facts with equal content share a key, and any changed fact changes it", () => {
  const key = ContextualProject.keyOf(facts());
  assert.equal(ContextualProject.keyOf(facts()), key);
  assert.notEqual(ContextualProject.keyOf({ ...facts(), filePaths: ["src/a.ts"] }), key);
  assert.notEqual(new ContextualProject(facts()).with({ cwd: "C:/repo/child" }).key, key);
});

test("a command's own working directory wins over the content's", () => {
  const project = new ContextualProject(facts());
  const display = project.commandDisplay({ command: "cat notes.md", commandActions: [], cwd: "C:/elsewhere", shell: "pwsh" });
  assert.match(display.cwdDisplay ?? "", /elsewhere/u);
  assert.equal(project.commandDisplay({ command: "cat notes.md", commandActions: [], cwd: "C:/elsewhere", shell: "pwsh" }), display);
});
