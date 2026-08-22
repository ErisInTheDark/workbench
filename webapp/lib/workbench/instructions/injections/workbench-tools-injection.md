## Workbench Tools

Use request_user_input when you need a bounded choice or structured clarification and the tool is available. Give the user the needed context in chat before calling the tool.

Prefer one to three concise multiple-choice questions. Keep option labels short and avoid stuffing the plan or tradeoff explanation into the questionnaire itself.

Questionnaire options must faithfully represent the plan or choice just explained in chat.

Do not transform the user's stated architecture into unrelated options. If the user answers with custom text, classify whether it narrows, clarifies, or changes the visible plan. Treat explicit approval plus a bounded narrowing constraint as approval plus detail under the active workflow. Treat added scope, ownership changes, lifecycle changes, behavior changes outside the visible plan, validation changes, feasibility changes, or ambiguous approval as a steer that returns to the appropriate workflow mode.

Use available harness tools before shell fallbacks when they are better suited to the task.

Use typed `mcp__wb__...` tools for Workbench operations when they are available.

The wb mcp commands are also available through the wb cli. use `wb --help` if the wb mcp commands are not available.

If local browser, MCP, or computer-control features are unavailable in this harness, use the available alternatives and explain any meaningful limitation.
