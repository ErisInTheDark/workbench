## Task orientation guidance

1. Search (not read) `docs/GLOSSARY.md` for vague terminology the user gives that could have project meaning.
2. Before planning or editing project behaviour or architecture, read all files that seem relevant under `docs/invariants/`.
3. If finding a term, invariant, or code takes more than one search, consider proposing a durable instruction or code improvement.
4. Propose only succinct, truly durable and useful glossary terms and invariants; you needing them does not mean many agents will need them. Show exact proposed text prominently. Do not add headings or prose.

## Updating Instructions

In this project, "update instructions" means update Markdown sources under `instructions/`. The user will explicitly name "the root AGENTS.md" or a particular skill when intending those.

CRITICAL INSTRUCTION EDITING RULES:
- "Strengthening" instructions does not mean more words!!!!! It means making the existing words more clear and EMPHASISED.
- When adding new rules, think deeply about how to bake them into the existing text. Aim for more clear rules expressed in less overall words. Be very careful not to remove or weaken existing rules unless that's the intent.
- Keep emitted instructions concise. HTML comments are stripped from emitted instructions and this AGENTS.md; they add no runtime instruction tokens. Use comments freely for detailed rationale about agent failure patterns and why rules prevent them, not specific incidents. Preserve useful existing context; do not shorten comments to save instruction tokens. Count emitted instruction tokens before and after edits.

## Code Organization
- Add and maintain start-of-file manifest comments — list every export with a succinct one-line purpose, to improve discoverability. Do not include a list of generic keywords.  Proactively fix nonconforming manifests in files you edit. 

## UI Constraints

- Follow the flush/zen visual language: use minimal borders, add backgrounds only when necessary, use gradient masks when they clarify separation, and give buttons a background only on hover.
- Support both light and dark color schemes in every visual change.
- Make desktop and mobile behavior deliberate, especially for split explorer/editor layouts, sticky controls, and save/reset affordances.

## Contracts, Sources, and Equality

- Keep shared client/server code synchronized through shared types. Do not use `any` or `unknown` in shared contracts, and do not leave API contracts or state flow half-migrated.
- When a browser boundary rejects server, bridge, or WebSocket data with Zod, call `reportClientSchemaError` from `shared/workbench/report-client-schema-error.ts` before returning. Keep the report bounded and sanitized; never serialize the rejected payload or its values. Expected local validation of user input, URLs, or persisted layout state does not need remote-boundary logging when its rejection is fully handled.
- For app-core, shared-contract, thread-rendering, route, or instruction-generation changes, work in live-safe, compile-safe vertical slices. Preserve compatibility until all consumers are migrated. Never leave the watched app or workflow/checkpoint endpoints broken between edits or while awaiting user input.
- Put additive Zod compatibility defaults on the schema. New browser code and old server code must work in either reload order. Read repairable persisted state through `conformToZodSchema`; do not throw for schema drift.
- Edit Workbench-owned prompt and workflow Markdown under `instructions/`, not generated Workbench-library files. Confirm the source-to-generated path before planning.
- Do not use `JSON.stringify` for equality. Compare explicit fields when the owner has meaningful equality rules, use the shared deep-equality utility for JSON-like structural data, and reserve stable serializers for serialization, signatures, logs, cache keys, request bodies, or display text.

## Endpoint and Lifecycle Invariants

- Do not add arbitrary short timeouts to production work. A timeout is valid only when completion after its deadline is itself a product failure; if late completion would still be correct or useful, keep the work lifecycle-owned and expose progress or caller-owned cancellation instead of manufacturing a timeout failure. Every real deadline must name its owner, reason, failure behavior, and regression proof.
- Do not swallow, bury, or silently discard unexpected failures. Surface every unexpected failure at its owning boundary as a bounded sanitized warning/error and preserve typed failure propagation or durable failure state where the caller or product needs it. Silence is allowed only for an explicitly expected condition whose handling is complete and regression-tested; empty catches, ignored rejections, and quiet fallback paths are not error handling.
- Project-scoped agent endpoints derive ownership from the agent's validated `cwd`, never a caller-supplied `projectId`. Keep `projectId` as UI/app selection state and resolved response/storage identity only.
- Keep the app server thin. It owns static SPA serving, app-local state, reload and port controls, and bounded client log admission. It must not own daemon domain behaviour.
- Keep the browser client thinner. It owns rendering and interaction to apply intent into the app server or daemon server.
- Keep browser-to-daemon RPC on the shared typed WebSocket. Use daemon HTTP only for CLI/MCP ingress, health, assets, and HTTP streaming. Do not create per-request WebSocket clients.
- Make long-lived daemon changes reload-capable in the same changeset. When a scoped reload or full restart will be needed, prominently tell the user which. You must be confident about what reloads will be required, this is a required step of inspection. Reloads and restarts are user-owned. Never include them in agent work or plans, run them, or request permission.
- Keep project discovery coalesced and `cwd`-validated with watcher invalidation and a bounded soft refresh. Do not reintroduce per-request project walks, and keep explorer tree snapshot caching separate from project discovery.
- Give every new long-lived subsystem an explicit reload/disposal boundary.
- Treat the reloadable projects as dependency graphs. Parents provide registrations to direct children, and reloading a node replaces its dependant closure. Put each subsystem at the lowest reloadable ancestor that spans its dependants; do not move cross-branch lifecycle into the projects' `index.ts` entrypoints or other non-reloadable imports.
- Avoid introducing or modifying non-reloadable daemon or app code. If you must, explicitly call out that the user will need to perform a full-process restart (of whichever process must be restarted).

## Commands and Permission Boundaries

Run `wb test` and `pnpm typecheck` from the repository root.

### Allowed Validation

`pnpm typecheck`

`wb test` tests full suite filtered by claims (run this first!)
`wb test -- [<file>...]` tests only the specified files (useful for targeted retests)

note: the following two scenario tests take a LONG time, and should be used for FINAL validation; do not set a timeout!
`pnpm test:lifecycle` runs a clone of the full app, testing schema migration; do not use if you have not changed the db!
`pnpm test:live` runs a clone of the full app, testing with a paid luna low codex turn; only use when the user asks for it!

`cargo test --manifest-path ..\tray\Cargo.toml`
`cargo build --release --manifest-path ..\tray\Cargo.toml`

<!-- - For agent-thread rendering, use `http://localhost:<port>/agent/thread/<threadId>` for the chrome-free thread view and `http://localhost:<port>/agent/thread-lab` for pasted payload, turn, item, command-string, and simplified-command rendering checks. -->

<!-- ### Ask the User First

A direct user request to perform a specific bounded action counts as explicit permission for that exact action, including when delivered as a steer. Use a questionnaire when permission has not already been given, the request is ambiguous, or a bounded scope choice still needs user input.

- Obtain explicit user permission before calling any non-GET Workbench daemon endpoint directly.
- Ask before running installs, generation, formatting, migration, cleanup, build, or other commands that write artifacts or disturb active watch/runtime state. -->

### Forbidden Shortcuts

- Do not run random `pnpm` scripts because they seem related. Know what you're doing before you do things.
