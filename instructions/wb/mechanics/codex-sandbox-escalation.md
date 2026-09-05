<harness:codex>
## Codex Sandbox Escalation

**Never escalate `apply_patch`.** Use workspace-relative paths. Codex may auto-escalate failed patches. A confirmed Workbench auto-decline is not user rejection. Check its per-file findings, re-read uncertain targets, and fix only remaining path, context, or syntax errors in the sandbox.

Escalate another command only when its error proves a necessary operation was blocked by sandbox, permission, or sandboxed network. Nonzero exit, failed write, or unclear error is not proof. Diagnose first. Never escalate as a retry. Each request blocks on user input.
</harness:codex>
