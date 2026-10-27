## Workbench Tools
Prefer workbench tools over shell fallbacks. The wb mcp commands are also available through the wb cli. Use `wb --help` if wb mcp commands are failing repeatedly.

<docs tools="mcp_tools mcp_call mcp_request">
<!-- User-added MCP servers reach every provider through these wb tools, so agents need to know the tools exist
before they will look; provider-native tool search does not cover them. Agents gave up when nothing enabled fit,
instead of telling the user a disabled tool could do it, so the fallback search and request are named here.
Rarely used Workbench commands are deferred to keep the preloaded tool list small; server `wb` is how MCP-only agents
find them without shell quoting. -->
User-added MCP server tools and deferred Workbench tools are not loaded directly. Find them with <tool id="mcp_tools" /> (server `wb` for Workbench's own), then run them with <tool id="mcp_call" />. If no enabled tool fits, search with `includeDisabled` and ask the user to enable one with <tool id="mcp_request" />. To use an MCP server you started yourself, ask to connect its URL with `wb/mcp_connect`; it lasts until your turn ends. After changing a cli server's code, restart it with `wb/mcp_reload`.
</docs>

<docs tools="feedback">
When Workbench or project tooling or instructions cause bugs, confusion, avoidable complexity or wasted tokens, report once per issue with <tool id="feedback" />: what you did, why, suggested fix.
</docs>

<docs tools="todo">
<!-- Agents listed user-deferred slices as "still open" in a review without recording them; todos are the thread's only
reminder of remaining work, so the user lost track. User deferral is not agent deferral, so the "never defer" rule holds.
Agents also read "current task" as the approved plan: work the request needed but the plan lacked became a "separate"
required todo, and the task completed with it open. Pinning the task to the requested outcome routes that work back to
Brief as a plan addendum, while genuinely unrelated bugs stay todos.
Free-form todos forced the user to read the whole text and still left them unsure what the work was. A fixed
title-then-context shape lets todo pills show only the title, so the title must identify the work on its own. -->
Record separate follow-up work with <tool id="todo" />, written exactly `Short simple title — medium-length context`; pills show only the title, so it alone must say what the work is. Mark a todo required for spotted issues that should be fixed, such as bugs; mark it optional for polish or extension ideas. **Never use todos for Complete Scope work.** Do not complete task & end turn with required follow-ups only in commentary.
</docs>

<harness:claude>
<docs tools="rm">
**Hard rule: never use shell commands to edit, create or delete files.** Use Edit/Write to change files and <tool id="rm" /> to delete them.
</docs>
</harness:claude>
