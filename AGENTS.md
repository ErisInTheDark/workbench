# Workbench Agent Guidance

## What Belongs Here

- Keep this file limited to durable project constraints, project-skill routing, project-specific commands, validation commands, and explicit permission boundaries.
- Do not add architecture inventories, temporary implementation notes, changelogs, task-specific procedures, or facts that an agent can recover by inspecting the source.
- Update this file or nearby project guidance when a change materially alters a durable project constraint or operating workflow, and confirm that guidance change with the user.

## Project Skills

- `/opencode-diagnostics` owns the bounded local SDK-probe workflow for diagnosing OpenCode connectivity, event streams, sessions, prompt delivery, and bridge behavior under `webapp/orchestrator/`.

## Code Organization

- Prefer reusable components. A reusable component should be the default export of a matching PascalCase file, such as `ThreadView.tsx`.
- Prefer prominent controllers and state owners. A controller or state-owning function/class should be the default export of a matching PascalCase file, such as `WorkbenchClient.ts`.
- Use kebab-case filenames for miscellaneous functions, types, and registries, such as `command-matchers.ts`.
- Put related transformations in registries instead of hardcoded dispatch branches. Split large registries into a core registry that imports focused registry items or groups.
- Add and maintain a start-of-file manifest comment in files containing multiple components, functions, types, or other exports. Include high-signal keywords and list every export with a one-line purpose; proactively fix nonconforming manifests in files you edit.
- Organize Workbench instruction sources under `webapp/lib/workbench/instructions/` by kind. Keep instruction payload leaves as Markdown with one semantic unit per file. Read each source once per instruction-use generation, and do not permanently cache internal instruction content across uses. Keep `WorkbenchPromptFiles.ts` as the public freshness and assembly entrypoint.
- Keep files small, reusable, and conceptually coherent. Plan the nearby refactor when the requested change would otherwise deepen a monolith, duplicate ownership, or add helper soup.
- Do not create file-specific duplicate components, utilities, or types when a shared owner already exists.

## UI Constraints

- Follow the flush/zen visual language: use minimal borders, add backgrounds only when necessary, use gradient masks when they clarify separation, and give buttons a background only on hover.
- Support both light and dark color schemes in every visual change.
- Make desktop and mobile behavior deliberate, especially for split explorer/editor layouts, sticky controls, and save/reset affordances.

## Contracts, Sources, and Equality

- Keep shared client/server code synchronized through shared types. Do not use `any` or `unknown` in shared contracts, and do not leave API contracts or state flow half-migrated.
- When a browser boundary rejects server, bridge, or WebSocket data with Zod, call `reportClientSchemaError` from `webapp/lib/workbench/report-client-schema-error.ts` before returning. Keep the report bounded and sanitized; never serialize the rejected payload or its values. Expected local validation of user input, URLs, or persisted layout state does not need remote-boundary logging when its rejection is fully handled.
- For app-core, shared-contract, thread-rendering, route, or instruction-generation changes, work in compile-safe vertical slices. Preserve compatibility until all consumers are migrated, and do not leave the app or workflow/checkpoint endpoints broken while awaiting user input.
- Edit Workbench-owned prompt and workflow sources under `webapp/lib/workbench/instructions/`, not generated Workbench-library files. Confirm the source-to-generated path before planning.
- Do not use `JSON.stringify` for equality. Compare explicit fields when the owner has meaningful equality rules, use the shared deep-equality utility for JSON-like structural data, and reserve stable serializers for serialization, signatures, logs, cache keys, request bodies, or display text.

## Endpoint and Lifecycle Invariants

- Do not add arbitrary short timeouts to production work. A timeout is valid only when completion after its deadline is itself a product failure; if late completion would still be correct or useful, keep the work lifecycle-owned and expose progress or caller-owned cancellation instead of manufacturing a timeout failure. Every real deadline must name its owner, reason, failure behavior, and regression proof.
- Do not swallow, bury, or silently discard unexpected failures. Surface every unexpected failure at its owning boundary as a bounded sanitized warning/error and preserve typed failure propagation or durable failure state where the caller or product needs it. Silence is allowed only for an explicitly expected condition whose handling is complete and regression-tested; empty catches, ignored rejections, and quiet fallback paths are not error handling.
- Project-scoped agent endpoints derive ownership from the agent's validated `cwd`, never a caller-supplied `projectId`. Keep `projectId` as UI/app selection state and resolved response/storage identity only.
- Treat Next.js routes as stateless serverless handlers. Do not rely on route-module memory, timers, or warm-process caches for correctness; store durable state on disk/git or delegate long-lived state and lifecycle to the orchestrator.
- Keep Next-to-orchestrator one-shot RPC on the allowlisted buffered HTTP boundary. Reserve bridge WebSockets for persistent browser clients and notification streams, and do not create one-shot app-server sockets inside Next routes.
- Make changes to long-lived orchestrator behavior reload-capable in the same changeset, or explicitly tell the user that a full orchestrator restart is required.
- Keep reloads non-destructive and narrowly scoped. `orchestrator-logic` reloads only declared reloadable modules; `codex-bridge` must preserve the Codex app-server process, pending bridge state, and browser WebSocket clients; `browse-controller` must drain and replace controller code without restarting browser sessions.
- Keep Browse command execution warm and orchestrator-owned, including direct daemon communication, per-session FIFO queues, deadlines, cancellation, and timed-out session retirement. Do not reintroduce an upstream Browse CLI child process per typed action; only the explicitly gated raw fallback may spawn it.
- Keep Browse result resolution and ordered sidecars out of the command transport, and keep thread-activity reads isolated to session-cleanup polling rather than the command path.
- Keep project discovery coalesced and `cwd`-validated with watcher invalidation and a bounded soft refresh. Do not reintroduce per-request project walks, and keep explorer tree snapshot caching separate from project discovery.
- Preserve an active subagent controller across a bridge reload only while it owns active waiters. Ordinary bridge reloads may recreate the controller but must not restart the stable Codex app-server.
- Give every new long-lived orchestrator subsystem an explicit reload/disposal boundary.
- Treat `webapp/orchestrator/index.ts` and other files outside the reloadable orchestrator feature/module graph as non-reloadable process-shell code. Do not edit one without explicit user approval that names the file and calls out the full-process restart and validation cost. Prefer implementing behavior in the reloadable feature/module graph.

## Commands and Permission Boundaries

Run project validation from `webapp/` unless a command says otherwise.

### Allowed Validation

```powershell
pnpm test
pnpm typecheck
```

- `pnpm test` executes the TypeScript `node:test` suite through the project-owned runner.
- `pnpm typecheck` type-checks the app and orchestrator without emitting files.
- `pnpm test` and `pnpm typecheck` are the only allowed `pnpm` scripts for agent validation.
- When tests are added or changed, run `pnpm test`; typechecking test files does not count as executing their assertions.
- For agent-thread rendering, use `http://localhost:<port>/agent/thread/<threadId>` for the chrome-free thread view and `http://localhost:<port>/agent/thread-lab` for pasted payload, turn, item, command-string, and simplified-command rendering checks.

### Allowed Runtime Reloads

- Agents have permission to run `wb orchestrator reload` without additional user approval after making changes that require a reload. Use the narrowest applicable scope:

```text
wb orchestrator reload [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--opencode-bridge] [--opencode-server] [--next-dev]
```

- IMPORTANT: Reload the affected backend scope when required to activate a change. Next.js can hot-reload frontend code that expects matching backend behavior before that backend code is active, leaving the user's app broken until the backend reloads.
- Do not broaden a reload beyond the subsystem changed.

### Ask the User First

A direct user request to perform a specific bounded action counts as explicit permission for that exact action, including when delivered as a steer. Use a questionnaire when permission has not already been given, the request is ambiguous, or a bounded scope choice still needs user input.

- Obtain explicit user permission before calling any non-GET Workbench webapp endpoint directly.
- Ask before running installs, generation, formatting, migration, cleanup, build, or other commands that write artifacts or disturb active watch/runtime state.

### Forbidden Shortcuts

- Do not run any `pnpm` script other than `test` or `typecheck` for agent validation.
- Do not invoke `tsx` or another ad hoc test runner directly; use the project-owned `pnpm test` script.
- Do not use browser testing unless approved by the user.
