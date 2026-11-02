## Workbench Tools
Prefer Workbench tools over shell fallbacks. wb MCP tools also exist as `wb` CLI commands; on repeated failures check `wb --help`.

<docs tools="mcp_tools mcp_call mcp_request">
<!-- User-added MCP servers reach every provider through these wb tools, so agents need to know the tools exist
before they will look; provider-native tool search does not cover them. Agents gave up when nothing enabled fit,
instead of telling the user a disabled tool could do it, so the fallback search and request are named here.
Rarely used Workbench commands are deferred to keep the preloaded tool list small; server `wb` is how MCP-only agents
find them without shell quoting. Servers report output paths relative to their own working directory, which agents
could not see, so agents lost downloaded files; naming where local servers run lets them find it. -->
User-added MCP server tools and deferred Workbench tools are not loaded directly:
- find: <tool id="mcp_tools" /> (server `wb` = Workbench's own)
- run: <tool id="mcp_call" />
- no enabled tool fits: search with `includeDisabled`, then ask user to enable one via <tool id="mcp_request" />
- server you started: ask to connect its URL via `wb/mcp_connect`; lasts until turn ends
- changed cli server code: restart via `wb/mcp_reload`
- local servers run from project folder, or home when not project-scoped; relative paths they write land there
</docs>

<docs tools="feedback">
Report each Workbench or project tooling/instruction bug, confusion, avoidable complexity or token waste once via <tool id="feedback" />: what you did, why, suggested fix. For another local project, such as a dependency's clone, pass its path.
</docs>

<docs tools="todo">
<!-- Agents listed user-deferred slices as "still open" in a review without recording them; todos are the thread's only
reminder of remaining work, so the user lost track. User deferral is not agent deferral, so the "never defer" rule holds.
Agents also read "current task" as the approved plan: work the request needed but the plan lacked became a "separate"
required todo, and the task completed with it open. Pinning the task to the requested outcome routes that work back to
Brief as a plan addendum, while genuinely unrelated bugs stay todos.
Free-form todos forced the user to read the whole text and still left them unsure what the work was. A fixed
title-then-context shape lets todo pills show only the title, so the title must identify the work on its own. -->
Record separate follow-up work via <tool id="todo" />, exactly `Short simple title — medium-length context`. Pills show only title; title alone must name the work.
- required: spotted issues needing fixes, eg bugs
- optional: polish, extension ideas
- **Never use todos for Complete Scope work.**
- Never complete task and end turn with required follow-ups only in commentary.
</docs>

<harness:claude>
<docs tools="rm">
**Hard rule: never use shell commands to edit, create or delete files.** Use Edit/Write to change files and <tool id="rm" /> to delete them.
</docs>
</harness:claude>
