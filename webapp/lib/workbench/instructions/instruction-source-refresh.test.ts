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
      fs.writeFile(path.join(temporaryInstructionRoot, "mechanics", "workbench-git-instructions.md"), "git revision two\n", "utf8"),
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
    assert.doesNotMatch(promptInstructions.baseInstructions ?? "", /skill precedence revision two/u);
    assert.doesNotMatch(promptInstructions.baseInstructions ?? "", /builtin skill revision two/u);
    assert.doesNotMatch(promptInstructions.developerInstructions ?? "", /builtin skill revision two/u);
    const builtinSkillPath = path.join(temporaryLibraryRoot, "skills", "builtin", "browse", "SKILL.md");
    const compactSkillCatalog = await promptFiles.buildWorkbenchSkillCatalogDeveloperInstructions({
      harness: "codex",
      threadId: "freshness-thread",
      workbenchOrigin: "http://workbench.test",
      workflowIds: ["default"],
    });
    assert.match(compactSkillCatalog ?? "", /skill precedence revision two/u);
    assert.ok((compactSkillCatalog ?? "").includes(
      `<skill filename="${builtinSkillPath.replaceAll("\\", "/")}" trigger="" />`,
    ));
    assert.doesNotMatch(compactSkillCatalog ?? "", /builtin skill revision two/u);
    const mentionedSkillCatalog = await promptFiles.buildWorkbenchSkillCatalogDeveloperInstructions({
      mentionedSkillPaths: [builtinSkillPath],
      harness: "codex",
      threadId: "freshness-thread",
      workbenchOrigin: "http://workbench.test",
      workflowIds: ["default"],
    });
    assert.match(mentionedSkillCatalog ?? "", /builtin skill revision two/u);
    assert.doesNotMatch(mentionedSkillCatalog ?? "", /\nname: browse\n/u);
    const projectSkillPath = path.join(temporaryProjectRoot, ".agents", "skills", "browse", "SKILL.md");
    await fs.mkdir(path.dirname(projectSkillPath), { recursive: true });
    await fs.writeFile(projectSkillPath, "---\nname: browse\n---\nproject browse skill\n", "utf8");
    const projectRoots = [{
      id: "project",
      isPrimary: true,
      name: "project",
      relativePath: "project",
      rootPath: temporaryProjectRoot,
    }];
    const shadowedBuiltin = await promptFiles.buildWorkbenchSkillCatalogDeveloperInstructions({
      mentionedSkillPaths: [builtinSkillPath],
      harness: "codex",
      roots: projectRoots,
      threadId: "freshness-thread",
    });
    assert.doesNotMatch(shadowedBuiltin ?? "", /builtin skill revision two/u);
    assert.doesNotMatch(shadowedBuiltin ?? "", /project browse skill/u);
    assert.ok((shadowedBuiltin ?? "").includes(
      `<skill filename="${projectSkillPath.replaceAll("\\", "/")}" trigger="" />`,
    ));
    const mentionedProjectSkill = await promptFiles.buildWorkbenchSkillCatalogDeveloperInstructions({
      mentionedSkillPaths: [projectSkillPath],
      harness: "codex",
      roots: projectRoots,
      threadId: "freshness-thread",
    });
    assert.match(mentionedProjectSkill ?? "", /project browse skill/u);
    assert.doesNotMatch(mentionedProjectSkill ?? "", /\nname: browse\n/u);
    assert.match(collaborationInstructions ?? "", /tools revision two/u);
    assert.equal(
      promptFiles.buildWorkbenchGitInstructions({
        harness: "codex",
        threadId: "freshness-thread",
        workbenchOrigin: "http://workbench.test",
      }),
      "git revision two",
    );

    assert.equal(await fs.readFile(path.join(temporaryLibraryRoot, "AGENTS.md"), "utf8"), "generated base revision two\n");
    assert.equal(await fs.readFile(path.join(temporaryLibraryRoot, "workflows", "DEFAULT.md"), "utf8"), "generated workflow revision two\n");
    assert.match(await fs.readFile(path.join(temporaryLibraryRoot, "skills", "builtin", "browse", "SKILL.md"), "utf8"), /builtin skill revision two/u);
    assert.equal(await fs.readFile(path.join(temporaryLibraryRoot, "agents", "default.md"), "utf8"), userAgent);
  } finally {
    process.chdir(originalCwd);
    if (originalLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
    else process.env.WORKBENCH_LIBRARY_ROOT = originalLibraryRoot;
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
