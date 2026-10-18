## Task orientation (required)

1. Search (not read) `docs/GLOSSARY.md` for vague terminology the user gives that could have project meaning. Search the glossary for any potentially project-specific words or locations whenever they appear in new user messages.
2. Before diagnosing, planning or editing project behaviour or architecture, read all files that seem relevant under `docs/invariants/`. Claims about intended behaviour must cite them.
3. If finding a term, invariant, or code takes more than one search, consider proposing a durable instruction or code improvement.
4. Propose only succinct, truly durable and useful glossary terms and invariants; you needing them does not mean many agents will need them. Show exact proposed text prominently. Do not add headings or prose.

| dir | project |
| --- | --- |
| /package | npm package: installer entrypoint, cli entrypoint, dotenv package replacement supporting wb-stored secrets |
| /daemon/host | wake service |
| /daemon/server | workbench harness |
| /daemon/voice | rust vtt service |
| /daemon/repo | go vfs service |
| /daemon/relay | go sandbox loopback relay (linux) |
| /daemon/launcher | go wb launcher (windows/linux); argv-exact daemon dispatch, endpoint discovery |
| /integration | integrations in third party software |
| /instructions | instructions for agents, copied into the user's `~/.workbench` folder whenever read |
| /app/server | server for frontend app. orchestrates daemons, batches requests |
| /app/client | frontend SPA. thin as possible |
| /app/tray | system tray application for the frontend app (rust/tauri) |
| /shared | shared stuff between the projects |
| /shared/network/native | go tailscale integration |
| /test | test runner |
| /scripts | stuff used by package scripts, installation |
| /docs | glossary and invariants ONLY |

## Updating Instructions

In this project, "update instructions" means update Markdown sources under `instructions/`. The user will explicitly name "the root AGENTS.md" or a particular skill when intending those.

CRITICAL INSTRUCTION EDITING RULES:
- Edit Workbench-owned prompt and workflow Markdown under `instructions/`, not generated Workbench-library files. Confirm the source-to-generated path before planning
- "Strengthening" instructions does not mean more words!!!!! It means making the existing words more clear and EMPHASISED.
- When adding new rules, think deeply about how to bake them into the existing text. ALWAYS aim for clearer rules overall expressed in fewer words. Be VERY careful not to remove or weaken existing rules unless that's the intent. DO NOT JUST BLINDLY INSERT. EXPLAIN WHY YOUR SHAPE IS BEST.
- HTML comments are stripped from emitted instructions and this AGENTS.md; they add no runtime instruction tokens. Use comments freely for detailed rationale about agent failure patterns and why rules prevent them. Do not detail specific incidents. Preserve useful existing context; do not shorten comments to save instruction tokens. Count emitted instruction tokens before and after edits.

## Other edit requirements
- Add and maintain start-of-file manifest comments — list every export with a succinct one-line purpose, to improve discoverability. Do not include a list of generic keywords. Proactively fix nonconforming manifests in files you edit
- DO NOT EDIT README
- Changes must be reload-capable. When a scoped reload or full restart will be needed, prominently tell the user which; must be confident about what reloads will be required, REQUIRED inspection step. Reloads and restarts are user-owned. Never include a permission request for them in agent work or plans; DO NOT run them unless requested

## Commands and Permission Boundaries

### Allowed Validation
do not apply timeouts for validation command runs! they own their own timeouts

1. `pnpm typecheck`

2. tests:
`wb test` tests full suite filtered by claims (run this first!)
`wb test -- [<file>...]` tests only the specified files (useful for targeted retests)

treat "noise" & slow/timing out tests in the output as relevant for your work. if you can address them, do so: DO NOT FILTER OUTPUT; FIX OUTPUT

3. expensive scenario tests if necessary:
note: the following two scenario tests take a LONG time, and should be used for FINAL validation
`pnpm test:lifecycle` runs a clone of the full app, testing schema migration; do not use if you have not changed the db!
`pnpm test:thread --<provider>=<paid|fake> [...--<provider>=<paid|fake>]` (eg `pnpm test:thread --codex=fake --opencode=paid`) runs clones of the full app, testing with paid or emulated provider turns, only use paid when the user asks for it!
`pnpm test:install` runs the real wb installer in a sandboxed home/VP_HOME with pretend host actions; use when changing `package/` installer or setup code

also available:
`cargo test --manifest-path ..\tray\Cargo.toml`
`cargo build --release --manifest-path ..\tray\Cargo.toml`

### Other available wb cli useful for workbench dev

- `wb ports` lists active Workbench listeners by port, domain, and protocol
- `wb transcript` read-only search and inspection of stored canonical transcripts, INCLUDING tool calls. less token efficient than thread recall, but thread recall is narrative-only
- `wb stats` diagnostics for claim, feedback, and tool-usage
- `wb debug socket` inspection of recent daemon/app WebSocket frames and exact payloads
