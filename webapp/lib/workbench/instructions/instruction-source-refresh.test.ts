/* No production exports. Tests protect per-use instruction-source freshness and Workbench Library override ownership. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("public instruction use refreshes generated files and preserves user-owned library content", async () => {
  const originalCwd = process.cwd();
  const originalLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
  const projectWorkbenchRoot = path.resolve(originalCwd, "..", ".workbench");
  await fs.mkdir(projectWorkbenchRoot, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(path.join(projectWorkbenchRoot, "instruction-loader-test-"));
  const temporaryProjectRoot = path.join(temporaryRoot, "project");
  const temporaryInstructionRoot = path.join(temporaryProjectRoot, "lib", "workbench", "instructions");
  const temporaryLibraryRoot = path.join(temporaryRoot, "library");
  const sourceInstructionRoot = path.join(originalCwd, "lib", "workbench", "instructions");

  try {
    await fs.mkdir(path.dirname(temporaryInstructionRoot), { recursive: true });
    await fs.cp(sourceInstructionRoot, temporaryInstructionRoot, { recursive: true });
    process.env.WORKBENCH_LIBRARY_ROOT = temporaryLibraryRoot;
    process.chdir(temporaryProjectRoot);
    const promptFiles = require("./WorkbenchPromptFiles") as typeof import("./WorkbenchPromptFiles");

    await promptFiles.buildWorkbenchPromptInstructions({
      harness: "codex",
      threadId: "freshness-thread",
      workbenchOrigin: "http://workbench.test",
      workflowIds: ["default"],
    });

    const userAgent = `---
name: User Agent
description: User-owned default agent
---
user-owned agent prompt
`;
    await fs.writeFile(path.join(temporaryLibraryRoot, "agents", "default.md"), userAgent, "utf8");
    await fs.writeFile(
      path.join(temporaryLibraryRoot, "AGENTS.override.md"),
      "user override\n\n{agent.definition}\n\n{workbench.skills}\n",
      "utf8",
    );

    await Promise.all([
      fs.writeFile(path.join(temporaryInstructionRoot, "base", "workbench-agents-prompt.md"), "generated base revision two\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "workflows", "default-workflow-prompt.md"), "generated workflow revision two\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "agents", "default-agent-prompt.md"), "generated agent revision two\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "mechanics", "workbench-git-instructions.md"), "git revision two for {{thread.id}}\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "injections", "workbench-tools-injection.md"), "tools revision two\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "skills", "workbench-skill-precedence.md"), "skill precedence revision two\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "skills", "browse-builtin-skill.md"), "---\nname: browse\n---\nbuiltin skill revision two\n", "utf8"),
    ]);

    const promptInstructions = await promptFiles.buildWorkbenchPromptInstructions({
      harness: "codex",
      threadId: "freshness-thread",
      workbenchOrigin: "http://workbench.test",
      workflowIds: ["default"],
    });
    const collaborationInstructions = await promptFiles.buildWorkbenchCollaborationDeveloperInstructions({
      harness: "codex",
      threadId: "freshness-thread",
      workbenchOrigin: "http://workbench.test",
      workflowIds: ["default"],
    });

    assert.match(promptInstructions.baseInstructions ?? "", /user override/u);
    assert.match(promptInstructions.baseInstructions ?? "", /user-owned agent prompt/u);
    assert.match(promptInstructions.baseInstructions ?? "", /skill precedence revision two/u);
    assert.match(collaborationInstructions ?? "", /tools revision two/u);
    assert.equal(
      promptFiles.buildWorkbenchGitInstructions({
        harness: "codex",
        threadId: "freshness-thread",
        workbenchOrigin: "http://workbench.test",
      }),
      "git revision two for freshness-thread",
    );

    assert.equal(await fs.readFile(path.join(temporaryLibraryRoot, "AGENTS.md"), "utf8"), "generated base revision two\n");
    assert.equal(await fs.readFile(path.join(temporaryLibraryRoot, "workflows", "DEFAULT.md"), "utf8"), "generated workflow revision two\n");
    assert.match(await fs.readFile(path.join(temporaryLibraryRoot, "skills", "builtin", "browse", "SKILL.md"), "utf8"), /builtin skill revision two/u);
    assert.equal(await fs.readFile(path.join(temporaryLibraryRoot, "agents", "default.md"), "utf8"), userAgent);
  } finally {
    process.chdir(originalCwd);
    if (originalLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
    else process.env.WORKBENCH_LIBRARY_ROOT = originalLibraryRoot;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
