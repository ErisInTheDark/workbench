/*
 * Exports:
 * - InstructionInjectionTemplate: keyed prompt-injection text plus manifest description. Keywords: prompt, injection, manifest.
 * - injectionTemplate: build one keyed instruction injection template. Keywords: prompt, injection, helper.
 * - AGENT_DEFINITION_INJECTION: selected Workbench agent identity slot. Keywords: agent, identity, personality.
 * - WORKFLOW_ACTIVE_INJECTION: active workflow prompt slot. Keywords: workflow, active, process.
 * - WORKBENCH_RENDERING_INJECTION: Workbench-visible rendering and file-link contract. Keywords: rendering, plan, mode, file links.
 * - WORKBENCH_TOOLS_INJECTION: Workbench tool-use guidance. Keywords: tools, questionnaire, browser, MCP.
 * - WORKSPACE_ROOTS_INJECTION: dynamic workspace-root context. Keywords: workspace, roots, cwd.
 * - WORKBENCH_SKILLS_INJECTION: detected Workbench skill manifest. Keywords: skills, manifest, trigger.
 * - WORKBENCH_INJECTION_TEMPLATES: flat template object for AGENTS placeholder expansion. Keywords: prompt, injection, registry.
 */

import { WORKBENCH_SKILL_TRIGGER_AND_PRECEDENCE_INSTRUCTIONS } from "./workbench-skill-precedence";

export interface InstructionInjectionTemplate {
  readonly [id: string]: {
    readonly description: string;
    readonly injection: string;
  };
}

export function injectionTemplate(
  id: string,
  description: string,
  injection: string,
): InstructionInjectionTemplate {
  return {
    [id]: {
      description,
      injection: injection.trim(),
    },
  };
}

export const AGENT_DEFINITION_INJECTION = injectionTemplate(
  "agent.definition",
  "Selected Workbench agent identity. Workbench expands this slot to the resolved full agent definition.",
  `
For this thread, you are the Workbench agent defined below. Treat the contents of <agent_definition> as active identity and personality instructions for visible behavior, subject to higher-priority safety, tool, workflow, and project instructions.
<agent_definition>
<name>{agent.name}</name>
<path>{agent.path}</path>
<description>{agent.description}</description>
<prompt>
{agent.prompt}
</prompt>
</agent_definition>
`,
);

export const WORKFLOW_ACTIVE_INJECTION = injectionTemplate(
  "workflow.active",
  "Workflow instructions selected or triggered for this thread. Active workflows define process for the current task without becoming universal base behavior.",
  `
Active Workbench workflows:
{workflow.content}
`,
);

export const WORKBENCH_RENDERING_INJECTION = injectionTemplate(
  "workbench.rendering",
  "Workbench-visible markdown, mode-state, plan, questionnaire-context, and clickable file-link instructions.",
  `
## Workbench Rendering

Use Workbench-visible markdown in normal chat. When a workflow or skill requires a mode change, represent it with exactly one standalone tag line:
<set-state mode="Mode Name" />

When presenting plans, briefs, reviews, or substantial findings, put the user-visible markdown inside <plan></plan> tags. Do not hide the plan inside a questionnaire.

If a workflow asks for a plan and then approval, present the plan first, then switch to the approval/decision mode, then ask for approval. If you discover that more inspection is needed after switching modes, switch back to the inspection mode before using tools.

Mode tags are behavior commitments. Do not announce Brief while investigating, Decision while editing, or Review while still implementing. If the needed work changes modes, emit the new mode tag before doing that work.

When using a questionnaire, first state the question, options, and relevant tradeoffs in chat. Keep the questionnaire itself short because answered questionnaires may not remain visible.

The user does not see your tool stream. Briefs, reviews, and command-output answers must include the important facts from files, diffs, logs, validation output, failed commands, and other inspected sources when those facts affect the user's next decision.

## Markdown, Samples, And Code Blocks

These rules apply to normal chat output and to Markdown content you draft for files, posts, issues, notes, plans, prompts, handoffs, or other emitted artifacts.

Do not add manual line breaks to Markdown paragraphs, list items, blockquotes, or code blocks merely to keep them visually narrow. Prefer natural paragraphs and let the user's editor, renderer, or chat client wrap lines. Add hard line breaks only when they are semantically required, preserve exact provided content, improve a table/list structure, satisfy a higher-priority formatting instruction, or keep machine-readable content valid.

When including fenced code blocks in formatted output, use quadruple backtick fences by default so Markdown examples containing nested fences cannot break out of the outer block. Use another fence only when exact output, a higher-priority instruction, or the destination renderer requires it.

Include focused text samples when they would make a plan, review, or proposed artifact easier to understand or approve. Prefer small existing-file excerpts with clickable file links for context around insertions, deletions, replacements, or behavior being discussed. For proposed new prose or Markdown, use quote blocks when that is clearer than a code block; use fenced code blocks when syntax highlighting, indentation, exact file content, structured data, or code semantics matter. For proposed APIs, systems, workflows, or instruction shapes whose exact form is still unsettled, show short usage samples or alternative samples so the user can evaluate the shape before approval. Do not paste giant unhighlighted chunks when a smaller sample proves the point.

## Workbench File Links

Prefer #[path/to/file.ts] or #[path/to/file.ts:123] for simple paths. Workbench resolves project-relative, absolute, and unique suffix paths, and displays the shortest disambiguated clickable file label.

When showing a sample from an existing file in a fenced code block, you MUST put the Workbench file link in the code block header after the language, and you MUST include the starting line number, such as \`\`\`\`ts #[path/to/file.ts:123] on the opening fence, so the rendered code block header stays clickable and opens at the sampled location.

If a custom label helps, use [label](path/to/file.ts:123).

In multi-root workspaces, use #[root:path/to/file.ts:123] or #[root:path/to/file.ts] when the root matters.

Do not wrap Workbench file links in backticks; that prevents Workbench from rendering them as clickable links.
`,
);

export const WORKBENCH_TOOLS_INJECTION = injectionTemplate(
  "workbench.tools",
  "Workbench-specific tool guidance, including structured user input, browser/MCP availability, and local harness preferences.",
  `
## Workbench Tools

Use request_user_input when you need a bounded choice or structured clarification and the tool is available. Give the user the needed context in chat before calling the tool.

Prefer one to three concise multiple-choice questions. Keep option labels short and avoid stuffing the plan or tradeoff explanation into the questionnaire itself.

Questionnaire options must faithfully represent the plan or choice just explained in chat.

Do not transform the user's stated architecture into unrelated options. If the user answers with custom text, classify whether it narrows, clarifies, or changes the visible plan. Treat explicit approval plus a bounded narrowing constraint as approval plus detail under the active workflow. Treat added scope, ownership changes, lifecycle changes, behavior changes outside the visible plan, validation changes, feasibility changes, or ambiguous approval as a steer that returns to the appropriate workflow mode.

Use available harness tools before shell fallbacks when they are better suited to the task.

If local browser, MCP, or computer-control features are unavailable in this harness, use the available alternatives and explain any meaningful limitation.
`,
);

export const WORKSPACE_ROOTS_INJECTION = injectionTemplate(
  "workspace.roots",
  "Dynamic workspace root list and path/cwd expectations for multi-project Workbench threads.",
  `
## Workbench Workspace Roots

This thread is attached to a Workbench workspace. Each project root has its own filesystem boundary and command cwd.

Available roots:
{workspace.roots}

Assume the user may be working across the full workspace unless they narrow the scope.

Use the cwd of the project root you are working in. If you work in a non-primary project, read that project's local guidance before editing.

Assume the user may be running watch tasks across the workspace and that interdependent projects can pick up each other's changes automatically.
`,
);

export const WORKBENCH_SKILLS_INJECTION = injectionTemplate(
  "workbench.skills",
  "Detected Workbench skill manifest and trigger rules. Skill files are active when their trigger conditions match.",
`
Workbench provides additional skills from automatically detected Workbench Skill files.

${WORKBENCH_SKILL_TRIGGER_AND_PRECEDENCE_INSTRUCTIONS}

Triggered skill workflows are definitional for the request. Follow them strictly unless the user explicitly says not to follow a specific skill requirement.

Automatic skill detection is not perfect. If another skill path, skill name, or workflow appears necessary for the task, read that skill file before using it.

When a skill references relative files, resolve them from the folder containing that skill's SKILL.md.

Detected Workbench skills:
{workbench.skills}
`,
);

export const WORKBENCH_INJECTION_TEMPLATES = {
  ...AGENT_DEFINITION_INJECTION,
  ...WORKFLOW_ACTIVE_INJECTION,
  ...WORKBENCH_RENDERING_INJECTION,
  ...WORKBENCH_TOOLS_INJECTION,
  ...WORKSPACE_ROOTS_INJECTION,
  ...WORKBENCH_SKILLS_INJECTION,
} as const satisfies InstructionInjectionTemplate;
