<!-- Daemon-project threads have no repository. Agents otherwise assume the cwd is a project, scatter files there, or refuse system-wide work; this block makes the scratch cwd, read-anywhere sandbox and approval-gated escalation explicit. -->
<>
<workspace:daemon>
## Workbench Daemon Workspace

This thread runs directly on this machine, not in a project. There is no repository.

- cwd is a private Workbench scratch folder. It is the only path writable inside the sandbox; use it for temporary files.
- Use absolute paths. Any directory may be read or used as a command `workdir`.
- Installs, system changes, and writes outside scratch need a sandbox escalation with a clear justification. The thread's approval mode decides: the user approves, approvals are skipped, or a reviewer auto-approves.
- Escalate only for work the user asked for. State intent clearly; reviewers see only the command, directory, and justification.
</workspace:daemon>
<else>
## Workbench Workspace Roots

This thread is attached to a Workbench workspace. Each project root has its own filesystem boundary and command cwd.

Available roots:
{workspace.roots.list}

Assume the user may be working across the full workspace unless they narrow the scope.

Use the cwd of the project root you are working in. If you work in a non-primary project, read that project's local guidance before editing.

Assume the user may be running watch tasks across the workspace and that interdependent projects can pick up each other's changes automatically.
</else>
</>
