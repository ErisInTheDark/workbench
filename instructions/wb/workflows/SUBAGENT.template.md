# SUBAGENT.md Editing Guide

SUBAGENT.md orients spawned Workbench subagents.

Edit this file when you want to change what spawned agents understand about their role, autonomy, boundaries, or limitations.

Good things to put here:

- what a subagent is
- how tightly it should follow its assignment
- how it should handle user or parent-agent steering
- what to report when finished
- limitations of subagent threads, such as unreliable questionnaire support
- how plans reach the parent for approval, and the subagent's mode gates

Do not put these here:

- loop rules both workflows share; edit those in `shared/`
- agent personality or voice
- broad project coding standards
- instructions that should apply to every Workbench thread

Related files:

- DEFAULT.md is the normal Workbench thread workflow.
- `shared/*.md` holds loop text DEFAULT.md and SUBAGENT.md both import, written for the approver each workflow defines.
- agents/default.md is the default agent identity.
- SUBAGENT.override.md replaces SUBAGENT.md when present.

