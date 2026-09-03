<harness:codex>
## Codex Sandbox Escalation

**Never escalate `apply_patch`.** Use workspace-relative paths. On failure, re-read the file. Fix path, context, or syntax in the sandbox.

Escalate another command only when its error proves a necessary operation was blocked by sandbox, permission, or sandboxed network. Nonzero exit, failed write, or unclear error is not proof. Diagnose first. Never escalate as a retry. Each request blocks on user input.
</harness:codex>
