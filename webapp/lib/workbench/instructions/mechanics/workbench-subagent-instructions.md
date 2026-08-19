## Workbench Subagent CLI

Workbench owns subagents exclusively through the allowlisted `wb subagent` command suite. No other subagent tools are approved.
Run every command from the intended project cwd; the CLI privately supplies that cwd and the current managed thread identity.

### Managing subagents
`wb subagent list` lists every unsettled direct child.

`wb subagent list --settled [--cursor <cursor>] [--limit <1-20>]` lists settled history.

`wb subagent profiles` lists profiles available to this thread. Use a profile ID only as the machine value for `--profile`. When talking to the user, always use the profile's user-facing `name`, never its ID.

`wb subagent create --profile <profile-id> --name <name> --title <title> --message <message>` creates and starts a child. Every flag is required. Choose a unique, person-like name the user can use conversationally. Let your active agent identity influence the name, but do not use a task slug, role label, or operation codename; `--title` owns the task description. Workbench preserves display spelling and resolves names case-insensitively.

When replacing a superseded child, choose a new person-like name. Do not append `2`, `II`, or another version suffix to the old name.

### Waiting for subagents
`wb subagent wait --name <name> [--name <name>...]` waits until the first target needs attention, completes, or stops.

Pass every active child in one wait command instead of building separate parallel waits. Treat the command as a blocking event wait, not as a polling primitive. Use a 25-minute shell timeout and keep the outer execution tool attached for the complete wait. A wait timeout cancels only that wait request, not any child turn.

Do not hide waits behind `Promise.all`, let an outer wrapper yield into a cell and repeatedly poll that cell with generic `functions.wait`, or substitute generic sleeping or idling. Those shapes conceal child questionnaires and completions behind unrelated work.

Do not include pointless "anxiety commentary" between waits. We include a timeout on waits solely to allow user steers a chance to arrive. Workbench automatically combines waits in the log, but if you're interleaving waits with noisy commentary, this compression does not happen.

Use this command shape when `functions.exec` owns the shell call:

````js
// @exec: {"yield_time_ms": 1505000, "max_output_tokens": 5000}
const result = await tools.shell_command({
  command: "wb subagent wait --name <first-name> --name <second-name>",
  workdir: "<project cwd>",
  timeout_ms: 1500000,
});
text(result);
````

`wb subagent message --name <name> --message <message>` sends ordinary prose to an unsettled direct child as a steer. When no turn is active, it starts a new turn.

`wb subagent message --parent --message <message>` lets a direct child send info to its direct parent.

`wb subagent stop --name <name> [--name <name>...]` stops any number of unsettled direct children.

`wb subagent settle --name <name> [--name <name>...]` settles Completed or Stopped children and releases their names for reuse.

<shell:pwsh>
For a multiline create or message value in PowerShell, use a literal single-quoted here-string:

````powershell
wb subagent message --name <name> --message @'
first line
second line
'@
````
</shell:pwsh>

<shell:bash>
For a multiline create or message value in Bash, use a quoted heredoc:

````bash
wb subagent message --name <name> --message "$(cat <<'EOF'
first line
second line
EOF
)"
````
</shell:bash>

The returned subagent ID is its thread ID and can be used with Workbench Thread Recall. You may operate only on direct children owned by the current thread; sideways and grandchild access fails closed.

### Subagent notes & recipes
- The wait command is the only way to receive a subagent's final output. Do not leave them hanging with no wait.
- Without explicit instruction, subagents communicate through commentary (not visible to you). If you need to get preliminary info from a subagent before completion, ask it specifically to message you with what you need using the `wb subagent message --parent` command.
- Subagents are entirely isolated, they do not inherit any context of the parent or sibling threads. Prompts must be self-contained. Do not poison subagents by telling them to do or not to do <thing they don't know anything about>, they WILL hallucinate.
- Do not blindly trust subagent output. Subagents are often less intelligent models.
- When you are orchestrating subagent review passes, you must orchestrate STRONGLY and DELIBERATELY against infinite review loops and scope creep. You are responsible for getting the implementation or plan to an acceptable state as defined by the user or project requirements in a reasonable time frame. If you don't plan, prompt, or implement effectively, subagents will continue to find additional work to do endlessly.

