## Task orientation guidance

1. Always search the `GLOSSARY.md` for vague things the user refers to that may be specific to the project. Many common project-specific terms are defined there instead of in this AGENTS.md, to save tokens. 
2. Before planning or editing project behavior or architecture, search `INVARIANTS.md` for invariants related to the task at hand.
3. Do not read these files wholly except to make changes. New glossary terms and invariants should be proposed as part of planned work when they are truly durable and useful for future agents. Propose them PROMINENTLY, with the exact proposed added text, and in the case of invariants, the section it will exist within. Do not add HTML comments to these files.
4. If it takes you more than a single search to find a relevant glossary term, invariant, or piece of code, propose a durable change to instructions or the code to reduce the search cost for future agents.

## Updating Instructions

In this project, "update instructions" means update sources under `webapp/lib/workbench/instructions/`. The user will explicitly name "the root AGENTS.md" or a particular skill when intending those. 

CRITICAL INSTRUCTION EDITING RULES:
- "Strengthening" instructions does not mean more words!!!!! It means making the existing words more clear and EMPHASISED.
- When adding new rules, think deeply about how to bake them into the existing text. Aim for more clear rules expressed in less overall words. Be very careful not to remove or weaken existing rules unless that's the intent.
- HTML comments are stripped from emitted instructions and this AGENTS.md. Use them to name the agent failure the surrounding instructions prevent. Count instruction tokens before and after edits.

## Code Organization

- Prefer reusable components. A reusable component should be the default export of a matching PascalCase file, such as `ThreadView.tsx`.
- Prefer prominent controllers and state owners. A controller or state-owning function/class should be the default export of a matching PascalCase file, such as `WorkbenchClient.ts`.
- Use kebab-case filenames for miscellaneous functions, types, and registries, such as `command-matchers.ts`.
- Put related transformations in registries instead of hardcoded dispatch branches. Split large registries into a core registry that imports focused registry items or groups.
- Add and maintain a start-of-file manifest comment in files containing multiple components, functions, types, or other exports. Include a list of high-signal keywords for the file, and separately list every export with a succinct one-line purpose; proactively fix nonconforming manifests in files you edit.
- Keep files small, reusable, and conceptually coherent. Plan the nearby refactor when the requested change would otherwise deepen a monolith, duplicate ownership, or add helper soup.
- Do not create file-specific duplicate components, utilities, or types when a shared owner already exists.

## UI Constraints

- Follow the flush/zen visual language: use minimal borders, add backgrounds only when necessary, use gradient masks when they clarify separation, and give buttons a background only on hover.
- Support both light and dark color schemes in every visual change.
- Make desktop and mobile behavior deliberate, especially for split explorer/editor layouts, sticky controls, and save/reset affordances.

## Contracts, Sources, and Equality

- Keep shared client/server code synchronized through shared types. Do not use `any` or `unknown` in shared contracts, and do not leave API contracts or state flow half-migrated.
- When a browser boundary rejects server, bridge, or WebSocket data with Zod, call `reportClientSchemaError` from `webapp/lib/workbench/report-client-schema-error.ts` before returning. Keep the report bounded and sanitized; never serialize the rejected payload or its values. Expected local validation of user input, URLs, or persisted layout state does not need remote-boundary logging when its rejection is fully handled.
- For app-core, shared-contract, thread-rendering, route, or instruction-generation changes, work in live-safe, compile-safe vertical slices. Preserve compatibility until all consumers are migrated. Never leave the watched app or workflow/checkpoint endpoints broken between edits or while awaiting user input.
- Put additive Zod compatibility defaults on the schema. New browser code and old server code must work in either reload order. Read repairable persisted state through `conformToZodSchema`; do not throw for schema drift.
- Edit Workbench-owned prompt and workflow sources under `webapp/lib/workbench/instructions/`, not generated Workbench-library files. Confirm the source-to-generated path before planning.
- Do not use `JSON.stringify` for equality. Compare explicit fields when the owner has meaningful equality rules, use the shared deep-equality utility for JSON-like structural data, and reserve stable serializers for serialization, signatures, logs, cache keys, request bodies, or display text.

## Endpoint and Lifecycle Invariants

- Do not add arbitrary short timeouts to production work. A timeout is valid only when completion after its deadline is itself a product failure; if late completion would still be correct or useful, keep the work lifecycle-owned and expose progress or caller-owned cancellation instead of manufacturing a timeout failure. Every real deadline must name its owner, reason, failure behavior, and regression proof.
- Do not swallow, bury, or silently discard unexpected failures. Surface every unexpected failure at its owning boundary as a bounded sanitized warning/error and preserve typed failure propagation or durable failure state where the caller or product needs it. Silence is allowed only for an explicitly expected condition whose handling is complete and regression-tested; empty catches, ignored rejections, and quiet fallback paths are not error handling.
- Project-scoped agent endpoints derive ownership from the agent's validated `cwd`, never a caller-supplied `projectId`. Keep `projectId` as UI/app selection state and resolved response/storage identity only.
- Keep the app server thin. It owns static SPA serving, app-local state, reload and port controls, and bounded client log admission. It must not own orchestrator domain behaviour.
- Keep the browser client thinner. It owns rendering and interaction to apply intent into the app server or orchestrator server.
- Keep browser-to-orchestrator RPC on the shared typed WebSocket. Use orchestrator HTTP only for CLI/MCP ingress, health, assets, and HTTP streaming. Do not create per-request WebSocket clients.
- Make long-lived orchestrator changes reload-capable in the same changeset. When a scoped reload or full restart will be needed, prominently tell the user which. You must be confident about what reloads will be required, this is a required step of inspection. Reloads and restarts are user-owned. Never include them in agent work or plans, run them, or request permission.
- Keep project discovery coalesced and `cwd`-validated with watcher invalidation and a bounded soft refresh. Do not reintroduce per-request project walks, and keep explorer tree snapshot caching separate from project discovery.
- Give every new long-lived subsystem an explicit reload/disposal boundary.
- Treat the reloadable projects as dependency graphs. Parents provide registrations to direct children, and reloading a node replaces its dependant closure. Put each subsystem at the lowest reloadable ancestor that spans its dependants; do not move cross-branch lifecycle into the projects' `index.ts` entrypoints or other non-reloadable imports.
- Avoid introducing or modifying non-reloadable daemon or app code. If you must, explicitly call out that the user will need to perform a full-process restart (of whichever process must be restarted).

## Commands and Permission Boundaries

Run project validation from `webapp/`. Run `pnpm typecheck` from the repository root.

### Allowed Validation

```
pnpm test
pnpm test -- --good-citizen
pnpm typecheck
cargo test --manifest-path ..\tray\Cargo.toml
cargo build --release --manifest-path ..\tray\Cargo.toml
```

- `pnpm test` executes the TypeScript `node:test` suite through the project-owned runner.
- Run `pnpm test -- --good-citizen` only when the user asks for it. Otherwise, run `pnpm test`.
- `pnpm typecheck` type-checks the app and orchestrator without emitting files.
- `pnpm test` and `pnpm typecheck` are the only allowed `pnpm` scripts for agent validation.
- Do not run `pnpm test` or `pnpm typecheck` unless your work has actually changed TypeScript code.
<!-- - For agent-thread rendering, use `http://localhost:<port>/agent/thread/<threadId>` for the chrome-free thread view and `http://localhost:<port>/agent/thread-lab` for pasted payload, turn, item, command-string, and simplified-command rendering checks. -->

<!-- ### Ask the User First

A direct user request to perform a specific bounded action counts as explicit permission for that exact action, including when delivered as a steer. Use a questionnaire when permission has not already been given, the request is ambiguous, or a bounded scope choice still needs user input.

- Obtain explicit user permission before calling any non-GET Workbench webapp endpoint directly.
- Ask before running installs, generation, formatting, migration, cleanup, build, or other commands that write artifacts or disturb active watch/runtime state. -->

### Forbidden Shortcuts

- Do not run any `pnpm` script other than `test` or `typecheck` for agent validation.
- Do not invoke `tsx` or another ad hoc test runner directly; use the project-owned `pnpm test` script.
