<!-- Daemon-project threads have no catalogue repository; machine Git arcs cover their file edits. Agents otherwise assume the cwd is a project, scatter files there, or refuse system-wide work; this block makes the scratch cwd, read-anywhere sandbox and approval-gated escalation explicit. -->
<!-- MCP tool calls run from the thread cwd; agents that cannot `cd` select another root through `workdir` where a tool offers it (arc tools use rootId/root:path instead). -->
<>
<workspace:daemon>
## Workbench Daemon Workspace

This thread runs directly on this machine, not in a project. File edits outside scratch go through machine Git arcs.

- cwd is a private Workbench scratch folder. It is the only path writable inside the sandbox; use it for temporary files.
- Use absolute paths. Any directory may be read or used as a command `workdir`.
- Installs, system changes, and shell writes outside scratch need a sandbox escalation with a clear justification. The thread's approval mode decides: the user approves, approvals are skipped, or a reviewer auto-approves.
- Escalate only for work the user asked for. State intent clearly; reviewers see only the command, directory, and justification.
</workspace:daemon>
<else>
## Workbench Workspace Roots

This thread is attached to a Workbench workspace. Each project root has its own filesystem boundary and command cwd.

Available roots:
{workspace.roots.list}

Assume the user may be working across the full workspace unless they narrow the scope.

Use the project root you are working in as command cwd, or as `workdir` on tools that accept it. If you work in a non-primary project, read that project's local guidance before editing.

Assume the user may be running watch tasks across the workspace and that interdependent projects can pick up each other's changes automatically.
</else>
</>
