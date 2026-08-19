# AGENTS.md Editing Guide

AGENTS.md is the universal Workbench base prompt.

Edit this file when you want instructions to apply across all Workbench-created threads, regardless of workflow or selected agent identity.

Good things to put here:

- universal Workbench behavior
- cross-workflow safety or quality expectations
- high-level tool and skill usage defaults that users may customize
- where injected context should appear
- how base instructions should combine with agent identities and workflows

Do not put these here:

- normal-thread approval workflow
- collaborator-only behavior
- subagent-only behavior
- agent personality or voice
- project-specific coding standards
- one user's temporary preference

AGENTS.override.md replaces AGENTS.md when present.

## Injections

AGENTS.md can include placeholders such as {workbench.rendering} or {agent.definition}. Workbench replaces them when creating a thread.

Unknown placeholders are left visible so mistakes are easier to notice.

Supported injections:

{injection.manifest}

## Common Layout

A typical AGENTS.md should include:

- universal base behavior
- {workbench.tools}
- {workbench.rendering}
- {workspace.roots}
- {agent.definition}
- {workflow.active}

Keep workflow-specific process in workflow files instead of AGENTS.md.

## Control-Flow Selectors

Workbench instruction sources can wrap conditional content in standalone `<harness:codex|copilot|opencode>`, `<shell:pwsh|bash>`, or `<available:mechanic-id>` blocks. Workbench filters the final assembled payload immediately before the owning harness sends it. Selector control lines are not sent to the agent.

Use selectors only when the content depends on the actual harness, shell, or emitted Workbench mechanic. Different selector axes can nest and all must match.

Lines inside Markdown code fences are examples, not active selectors.

Malformed selectors preserve ordinary content with a best-effort recovery and write a visible runtime warning. Fix every warning.

## Workbench Collaboration Mode

Workbench may use app-server Plan Mode to enable structured user input. Do not describe that capability mode as a no-edit rule. File modification rules belong to the active workflow, user approval, sandbox permissions, and project instructions.

