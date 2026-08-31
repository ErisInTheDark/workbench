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

## Relative Imports

Use `{./path/to/file}` or `{./path/to/file.md}` to import one Workbench Library Markdown file relative to the containing file.

Use `{./path/to/folder/*}` to import every direct active Markdown file in deterministic filename order. Globs ignore `.template.md` files.

Imported files can import more files. Every imported file independently prefers adjacent `X.override.md` over `X.md`.

Imports cannot leave the Workbench Library. Missing files, empty globs, and cycles fail assembly with the import chain.

## Runtime Slots

Workbench replaces small runtime values after imports expand. Injected values are opaque and cannot create more imports.

Stock runtime slots:

- `{agent.name}`, `{agent.path}`, `{agent.description}`, and `{agent.prompt}`
- `{subagent.identity}`
- `{workflow.content}`
- `{skills.catalog}`
- `{workspace.roots.list}`
- `{browse.raw-command-status}`
- caller-supplied workflow values

Unknown slots stay visible so mistakes are easy to notice.

The old composite slots `{agent.definition}`, `{workflow.active}`, `{workbench.rendering}`, `{workbench.tools}`, `{workbench.skills}`, and `{workspace.roots}` are unsupported. Import static policy files and use the small runtime slots instead.

## Common Layout

A typical AGENTS.md should include:

- universal base behavior
- `{./wb/mechanics/*}`
- agent framing around the `{agent.*}` slots
- `{subagent.identity}`
- workflow framing around `{workflow.content}`

Keep workflow-specific process in workflow files instead of AGENTS.md.

## Control-Flow Selectors

Workbench instruction sources can wrap conditional content in standalone `<harness:codex|copilot|opencode>`, `<shell:pwsh|bash>`, or `<available:mechanic-id>` blocks. Workbench filters the final assembled payload immediately before the owning harness sends it. Selector control lines are not sent to the agent.

Use selectors only when the content depends on the actual harness, shell, or emitted Workbench mechanic. Different selector axes can nest and all must match.

Lines inside Markdown code fences are examples, not active selectors.

Malformed selectors preserve ordinary content with a best-effort recovery and write a visible runtime warning. Fix every warning.

## Workbench Collaboration Mode

Workbench may use app-server Plan Mode to enable structured user input. Do not describe that capability mode as a no-edit rule. File modification rules belong to the active workflow, user approval, sandbox permissions, and project instructions.

