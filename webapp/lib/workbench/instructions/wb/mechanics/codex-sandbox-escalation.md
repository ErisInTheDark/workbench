<harness:codex>
## Codex Sandbox Escalation

Diagnose a command failure before retrying the command. A nonzero exit, failed write, or unclear error does not prove that the sandbox blocked the command. Inspect the error, target path, arguments, command behavior, and relevant workspace state first.

Request escalation only when concrete evidence identifies a sandbox, permission, or sandboxed-network restriction and the command is still necessary. Do not use escalation as a generic retry. Each escalation request blocks the turn on user input.
</harness:codex>
