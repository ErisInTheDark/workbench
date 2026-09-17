# instruction pack filters

Filters work in packs and other instruction sources. Put controls on separate lines; close with identical axis/value. Nested filters must all match. Fenced examples stay literal. Malformed controls preserve content and warn.

| axis | values |
|---|---|
| role | agent (default), voice-to-text |
| harness | exact provider id, e.g. codex |
| model | exact configured model id |
| shell | pwsh, bash |
| available | browse, browse-raw, long-waits, multi-root, subagents, thread-git, thread-recall, thread-refresh, task-status, task-title |

````md
<role:voice-to-text>
Preserve technical identifiers and deliberate profanity.
</role:voice-to-text>

<role:agent>
<harness:codex>
Use project-local conventions.
</harness:codex>
</role:agent>
````

Availability comes from trusted runtime capabilities, not instructions. Voice has no Workbench MCP mechanics. Put agent-only guidance inside role:agent; unfiltered text applies to both roles.
