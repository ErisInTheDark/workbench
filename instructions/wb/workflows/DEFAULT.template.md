# DEFAULT.md Editing Guide

DEFAULT.md controls the normal Workbench thread workflow.

Edit this file when you want to change how ordinary Workbench agents inspect, brief, ask for approval, implement, and review work.

Good things to put here:

- mode order and approval gates
- examples for confusing workflow routing
- when user prompts should map to Inspect, Brief, Decision, Implement, or Review
- when direct user requests can be handled immediately
- when to stop and re-plan
- how to recover after steers, compaction, or unexpected file edits

Do not put these here:

- agent personality or voice
- subagent limitations
- project-specific coding standards
- Workbench file-link syntax or tool contracts
- universal rules that should apply to every workflow

Related files:

- AGENTS.md is the universal base prompt.
- agents/default.md is the default agent identity.
- SUBAGENT.md is the subagent workflow.
- DEFAULT.override.md replaces DEFAULT.md when present.

