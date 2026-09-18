/* Exports: none. Protect instruction freshness, overrides, role-specific identity and skill precedence. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("public instruction use refreshes mirrored generated files and preserves active overrides", async () => {
  const originalCwd = process.cwd();
  const originalLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "instruction-loader-test-"));
  const temporaryProjectRoot = path.join(temporaryRoot, "project");
  const temporaryDaemonRoot = path.join(temporaryProjectRoot, "daemon");
  const temporaryInstructionRoot = path.join(temporaryProjectRoot, "instructions");
  const temporaryLibraryRoot = path.join(temporaryRoot, "library");
  const sourceInstructionRoot = path.resolve(originalCwd, "..", "instructions");

  try {
    await fs.mkdir(temporaryDaemonRoot, { recursive: true });
    await fs.cp(sourceInstructionRoot, temporaryInstructionRoot, { recursive: true });
    process.env.WORKBENCH_LIBRARY_ROOT = temporaryLibraryRoot;
    process.chdir(temporaryDaemonRoot);
    const promptFiles = require("./WorkbenchPromptFiles") as typeof import("./WorkbenchPromptFiles");
    const context = {
      cwd: temporaryProjectRoot,
      harness: "codex" as const,
      instructionInjections: { "custom.runtime": "custom workflow runtime" },
      roots: [{
        id: "project",
        isPrimary: true,
        name: "project",
        relativePath: "project",
        rootPath: temporaryProjectRoot,
      }],
      threadId: "freshness-thread",
      workbenchOrigin: "http://workbench.test",
      workflowIds: ["default"],
    };

    await promptFiles.buildWorkbenchPromptInstructions(context);

    const userAgent = `---
name: User Agent
description: User-owned default agent
---
user-owned agent prompt
{./agent-note}
`;
    const agentsOverride = [
      "user override",
      "{./custom/root}",
      "agent: {agent.prompt}",
      "{subagent.identity}",
      "workflow:",
      "{workflow.content}",
    ].join("\n\n");
    const workflowOverride = "user workflow override: {custom.runtime}\n";
    const gitOverride = "user git override\n";
    await fs.mkdir(path.join(temporaryLibraryRoot, "custom", "nested"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(temporaryLibraryRoot, "agents", "default.md"), userAgent, "utf8"),
      fs.writeFile(path.join(temporaryLibraryRoot, "agents", "agent-note.md"), "imported agent note\n", "utf8"),
      fs.writeFile(path.join(temporaryLibraryRoot, "custom", "root.md"), "base custom root\n", "utf8"),
      fs.writeFile(
        path.join(temporaryLibraryRoot, "custom", "root.override.md"),
        "custom root override\n{./nested/deep}\n",
        "utf8",
      ),
      fs.writeFile(path.join(temporaryLibraryRoot, "custom", "nested", "deep.md"), "base deep note\n", "utf8"),
      fs.writeFile(
        path.join(temporaryLibraryRoot, "custom", "nested", "deep.override.md"),
        "deep override revision one\n",
        "utf8",
      ),
      fs.writeFile(
        path.join(temporaryLibraryRoot, "agents", "alternate.md"),
        "---\nname: Alternate\nuser-invocable: true\n---\nbase alternate\n",
        "utf8",
      ),
      fs.writeFile(
        path.join(temporaryLibraryRoot, "agents", "alternate.override.md"),
        "---\nname: Alternate Override\nuser-invocable: true\n---\noverridden alternate\n{./agent-note}\n",
        "utf8",
      ),
      fs.writeFile(path.join(temporaryLibraryRoot, "AGENTS.override.md"), agentsOverride, "utf8"),
      fs.writeFile(path.join(temporaryLibraryRoot, "wb", "workflows", "DEFAULT.override.md"), workflowOverride, "utf8"),
      fs.writeFile(path.join(temporaryLibraryRoot, "wb", "mechanics", "git.override.md"), gitOverride, "utf8"),
      fs.writeFile(
        path.join(temporaryInstructionRoot, "AGENTS.md"),
        "generated base revision two\n{./wb/mechanics/*}\n{agent.prompt}\n{workflow.content}\n",
        "utf8",
      ),
      fs.writeFile(path.join(temporaryInstructionRoot, "wb", "workflows", "DEFAULT.md"), "generated workflow revision two\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "agents", "default.md"), "generated agent revision two\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "wb", "mechanics", "git.md"), "generated git revision two\n", "utf8"),
      fs.writeFile(path.join(temporaryInstructionRoot, "wb", "mechanics", "tools.md"), "generated tools revision two\n", "utf8"),
      fs.writeFile(
        path.join(temporaryInstructionRoot, "wb", "mechanics", "skills.md"),
        "skill policy revision two\n{skills.catalog}\n",
        "utf8",
      ),
      fs.writeFile(
        path.join(temporaryInstructionRoot, "wb", "mechanics", "newly-discovered.md"),
        "newly discovered mechanic\n",
        "utf8",
      ),
      fs.writeFile(
        path.join(temporaryInstructionRoot, "skills", "builtin", "browse", "SKILL.md"),
        "---\nname: browse\n---\nbuiltin skill revision two\n",
        "utf8",
      ),
      fs.writeFile(
        path.join(temporaryProjectRoot, "AGENTS.md"),
        "project root\n{./project-guidance/current}\n",
        "utf8",
      ),
      fs.mkdir(path.join(temporaryProjectRoot, "project-guidance"), { recursive: true }).then(async () => {
        await fs.writeFile(
          path.join(temporaryProjectRoot, "project-guidance", "current.md"),
          "project base revision one\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(temporaryProjectRoot, "project-guidance", "current.override.md"),
          "project override revision one\n",
          "utf8",
        );
      }),
    ]);

    const promptInstructions = await promptFiles.buildWorkbenchPromptInstructions(context);
    const baseInstructions = promptInstructions.baseInstructions ?? "";
    assert.match(baseInstructions, /user override/u);
    assert.match(baseInstructions, /custom root override/u);
    assert.match(baseInstructions, /deep override revision one/u);
    assert.match(baseInstructions, /user-owned agent prompt/u);
    assert.match(baseInstructions, /imported agent note/u);
    assert.match(baseInstructions, /user workflow override: custom workflow runtime/u);
    assert.doesNotMatch(
      baseInstructions,
      /base custom root|base deep note|user git override|generated git revision two|generated tools revision two|newly discovered mechanic|skill policy revision two|generated workflow revision two/u,
    );
    assert.doesNotMatch(baseInstructions, /builtin skill revision two/u);
    assert.doesNotMatch(promptInstructions.developerInstructions ?? "", /builtin skill revision two|workbench_mechanics/u);
    assert.match(
      promptInstructions.developerInstructions ?? "",
      /Apply the following project instructions at user-level priority\.[\s\S]*<project_instructions>[\s\S]*project root[\s\S]*project override revision one[\s\S]*<\/project_instructions>/u,
    );
    assert.doesNotMatch(promptInstructions.developerInstructions ?? "", /project base revision one|\{\.\/project-guidance/u);
    assert.doesNotMatch(baseInstructions, /project root|project override revision one/u);
    assert.doesNotMatch(baseInstructions, /<workbench_skills>/u);

    const selectedLibraryAgent = await promptFiles.buildWorkbenchPromptInstructions({
      ...context,
      agentPath: "library:agents/alternate.md",
    });
    assert.match(selectedLibraryAgent.baseInstructions ?? "", /overridden alternate/u);
    assert.match(selectedLibraryAgent.baseInstructions ?? "", /imported agent note/u);
    assert.doesNotMatch(selectedLibraryAgent.baseInstructions ?? "", /base alternate/u);

    const builtinSkillPath = path.join(temporaryLibraryRoot, "skills", "builtin", "browse", "SKILL.md");
    const activatedSkillCatalog = await promptFiles.buildWorkbenchActivatedSkillCatalog({
      ...context,
      activatedSkillPaths: [builtinSkillPath],
    });
    assert.match(activatedSkillCatalog ?? "", /builtin skill revision two/u);
    assert.doesNotMatch(activatedSkillCatalog ?? "", /\nname: browse\n/u);

    const threadUtilityInstructions = await promptFiles.buildWorkbenchThreadUtilityDeveloperInstructions(context);
    assert.match(threadUtilityInstructions ?? "", /user git override/u);
    assert.doesNotMatch(
      threadUtilityInstructions ?? "",
      /generated tools revision two|skill precedence revision two|<workbench_skills>/u,
    );
    assert.equal(
      await fs.readFile(path.join(temporaryLibraryRoot, "wb", "mechanics", "newly-discovered.md"), "utf8"),
      "newly discovered mechanic\n",
    );
    assert.equal(
      await fs.readFile(path.join(temporaryLibraryRoot, "AGENTS.md"), "utf8"),
      "generated base revision two\n{./wb/mechanics/*}\n{agent.prompt}\n{workflow.content}\n",
    );
    assert.equal(
      await fs.readFile(path.join(temporaryLibraryRoot, "wb", "workflows", "DEFAULT.md"), "utf8"),
      "generated workflow revision two\n",
    );
    assert.equal(
      await fs.readFile(path.join(temporaryLibraryRoot, "wb", "workflows", "DEFAULT.override.md"), "utf8"),
      workflowOverride,
    );
    assert.equal(
      await fs.readFile(path.join(temporaryLibraryRoot, "wb", "mechanics", "git.md"), "utf8"),
      "generated git revision two\n",
    );
    assert.equal(
      await fs.readFile(path.join(temporaryLibraryRoot, "wb", "mechanics", "git.override.md"), "utf8"),
      gitOverride,
    );
    assert.equal(
      await fs.readFile(path.join(temporaryLibraryRoot, "custom", "root.override.md"), "utf8"),
      "custom root override\n{./nested/deep}\n",
    );
    assert.equal(await fs.readFile(path.join(temporaryLibraryRoot, "agents", "default.md"), "utf8"), userAgent);
    assert.match(
      await fs.readFile(path.join(temporaryLibraryRoot, "skills", "builtin", "browse", "SKILL.md"), "utf8"),
      /builtin skill revision two/u,
    );

    await fs.writeFile(
      path.join(temporaryLibraryRoot, "custom", "nested", "deep.override.md"),
      "deep override revision two\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(temporaryProjectRoot, "project-guidance", "current.override.md"),
      "project override revision two\n",
      "utf8",
    );
    const nextTurnInstructions = await promptFiles.buildWorkbenchPromptInstructions(context);
    assert.match(nextTurnInstructions.baseInstructions ?? "", /deep override revision two/u);
    assert.doesNotMatch(nextTurnInstructions.baseInstructions ?? "", /deep override revision one|base deep note/u);
    assert.match(nextTurnInstructions.developerInstructions ?? "", /project override revision two/u);
    assert.doesNotMatch(nextTurnInstructions.developerInstructions ?? "", /project override revision one|project base revision one/u);

    const workbenchLibrary = require("../../workbench-library") as typeof import("../../workbench-library");
    const skillManifest = await workbenchLibrary.buildWorkbenchSkillManifestInstructions();
    assert.match(skillManifest ?? "", /skill policy revision two/u);
    assert.match(skillManifest ?? "", /builtin skill revision two/u);

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
    assert.equal(await promptFiles.buildWorkbenchActivatedSkillCatalog({
      activatedSkillPaths: [builtinSkillPath],
      harness: "codex",
      roots: projectRoots,
      threadId: "freshness-thread",
    }), null);
    assert.match(await promptFiles.buildWorkbenchActivatedSkillCatalog({
      activatedSkillPaths: [projectSkillPath],
      harness: "codex",
      roots: projectRoots,
      threadId: "freshness-thread",
    }) ?? "", /project browse skill/u);

    const voiceInstructions = await promptFiles.buildWorkbenchPromptInstructions({
      ...context, role: "voice-to-text", agentPath: "library:agents/does-not-exist.md",
    });
    assert.doesNotMatch(voiceInstructions.baseInstructions ?? "", /user-owned agent prompt|overridden alternate|imported agent note/u);
    assert.match(voiceInstructions.baseInstructions ?? "", /deep override revision two/u);
    assert.equal(voiceInstructions.developerInstructions, null);

    const removedCompositeSlots = [
      "old override",
      "{agent.definition}",
      "{workflow.active}",
      "{workbench.rendering}",
      "{workbench.tools}",
      "{workbench.skills}",
      "{workspace.roots}",
    ].join("\n");
    await fs.writeFile(path.join(temporaryLibraryRoot, "AGENTS.override.md"), removedCompositeSlots, "utf8");
    const unsupportedPrompt = await promptFiles.buildWorkbenchPromptInstructions(context);
    assert.equal(unsupportedPrompt.baseInstructions, removedCompositeSlots);
    assert.doesNotMatch(unsupportedPrompt.developerInstructions ?? "", /workbench_skills|workbench_mechanics/u);
  } finally {
    process.chdir(originalCwd);
    if (originalLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
    else process.env.WORKBENCH_LIBRARY_ROOT = originalLibraryRoot;
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
