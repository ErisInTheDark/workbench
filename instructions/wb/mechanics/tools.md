## Workbench Tools
Prefer workbench tools over shell fallbacks. The wb mcp commands are also available through the wb cli. Use `wb --help` if wb mcp commands are failing repeatedly.

<docs tools="feedback">
When Workbench or project tooling or instructions cause bugs, confusion, avoidable complexity or wasted tokens, report once per issue with <tool id="feedback" />: what you did, why, suggested fix.
</docs>

<harness:claude>
<docs tools="rm">
**Hard rule: never use shell commands to edit, create or delete files.** Use Edit/Write to change files and <tool id="rm" /> to delete them.
</docs>
</harness:claude>
