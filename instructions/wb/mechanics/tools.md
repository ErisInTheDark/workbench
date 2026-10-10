## Workbench Tools
Prefer workbench tools over shell fallbacks. The wb mcp commands are also available through the wb cli. Use `wb --help` if wb mcp commands are failing repeatedly.

<docs tools="feedback">
When Workbench or project tooling or instructions cause bugs, confusion, avoidable complexity or wasted tokens, report once per issue with <tool id="feedback" />: what you did, why, suggested fix.
</docs>

<docs tools="todo">
Record separate follow-up work with <tool id="todo" />. Mark a todo required for spotted issues that should be fixed, such as bugs; mark it optional for polish or extension ideas. Never use todos to defer work from the current task.
</docs>

<docs tools="vis_start vis_end">
To show the user a visual draft (mockup, layout, chart), write it as a project file and call <tool id="vis_start" />; they see it live as you edit. Prefer a `.tsx`/`.jsx` default export that imports the project's real components (needs `vis.build` in `.wb.json`); for `.html`/`.svg`, add `<link rel="workbench-css">` to `<head>` for project CSS (`vis.css`). Call <tool id="vis_end" /> when done.
</docs>

<harness:claude>
<docs tools="rm">
**Hard rule: never use shell commands to edit, create or delete files.** Use Edit/Write to change files and <tool id="rm" /> to delete them.
</docs>
</harness:claude>
