## Workbench Tools
Prefer workbench tools over shell fallbacks. The wb mcp commands are also available through the wb cli. Use `wb --help` if wb mcp commands are failing repeatedly.

<docs tools="mcp_tools mcp_call mcp_request">
<!-- User-added MCP servers reach every provider through these wb tools, so agents need to know the tools exist
before they will look; provider-native tool search does not cover them. Agents gave up when nothing enabled fit,
instead of telling the user a disabled tool could do it, so the fallback search and request are named here. -->
User-added MCP server tools are not loaded directly. Find them with <tool id="mcp_tools" />, then run them with <tool id="mcp_call" />. If no enabled tool fits, search with `includeDisabled` and ask the user to enable one with <tool id="mcp_request" />.
</docs>

<docs tools="feedback">
When Workbench or project tooling or instructions cause bugs, confusion, avoidable complexity or wasted tokens, report once per issue with <tool id="feedback" />: what you did, why, suggested fix.
</docs>

<docs tools="todo">
<!-- Agents listed user-deferred slices as "still open" in a review without recording them; todos are the thread's only
reminder of remaining work, so the user lost track. User deferral is not agent deferral, so the "never defer" rule holds.
Agents also read "current task" as the approved plan: work the request needed but the plan lacked became a "separate"
required todo, and the task completed with it open. Pinning the task to the requested outcome routes that work back to
Brief as a plan addendum, while genuinely unrelated bugs stay todos. -->
Record separate follow-up work with <tool id="todo" />. Mark a todo required for spotted issues that should be fixed, such as bugs; mark it optional for polish or extension ideas. **Never use todos for Complete Scope work.** Do not complete task & end turn with required follow-ups only in commentary.
</docs>

<harness:claude>
<docs tools="rm">
**Hard rule: never use shell commands to edit, create or delete files.** Use Edit/Write to change files and <tool id="rm" /> to delete them.
</docs>
</harness:claude>
