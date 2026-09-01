This file records permanent Workbench requirements.

Search this file for invariants related to the task at hand. Task specs can add stricter temporary rules. They cannot weaken these invariants.

You may propose new invariants or changes to existing invariants, but you must make these proposals PROMINENT, and they must be truly durable invariants that are useful for the project in the longterm.

## Ownership

- Give each durable fact, state, and lifecycle one owner.
- Keep external system details at their adapter boundary.
- Convert external data into shared Workbench types before core code uses it.
- Do not replace an existing owner as part of an additive change.
<!-- Prevent random connection ports or browser origins from redefining durable client state. -->
- Store app-owned preferences and drafts in app SQLite, never browser storage.
<!-- Prevent profile state from splitting between app SQLite and daemon thread state. -->
- Store thread, draft, and new-thread profiles in daemon thread state. App state does not own profiles.
- Scope daemon-owned references through app daemon registrations. Ports and addresses are connection locations, never identity.
<!-- Prevent ports, devices, and tabs from collapsing distinct browser state. -->
- Stable-port browser state uses one localStorage UUID per browser profile and one SQLite database per UUID. Random-port mode uses shared app state and stores no browser UUID. New browser databases seed from shared portable settings.
<!-- Prevent browser defaults from becoming stale or importing unfinished work. -->
- Successful stable-browser setting mutations refresh the shared seed. Draft content stays browser-owned and never enters that seed.
<!-- Prevent echoed persistence from replaying stale UI state. -->
- The browser client-state controller owns optimistic projection and per-identity mutation order. Consumers derive persisted state from its snapshot. They do not mirror and write back hydrated state.
<!-- Prevent suspended mobile tabs from trusting an unreplayable WebSocket stream. -->
- Treat browser visibility suspension as loss of live stream continuity. On resume, replace the browser WebSocket and rebuild pushed observations plus visible route state from authoritative owners.
<!-- Prevent app-port changes from racing persistence, stranding clients, or splitting runtime identity. -->
- Move the app port by binding the replacement before retiring the old listener. Preserve app runtime and state identity. Update browser and desktop origins together.
<!-- Prevent full app reload from racing the native singleton or opening duplicate static-port tabs. -->
- Full app reload launches the committed native tray replacement and waits for the previous tray to exit before singleton startup. Auto-open the browser only for random-port startup.
<!-- Prevent native release generation from requiring a running Workbench shutdown. -->
- Keep the committed tray launcher path replaceable while it runs. Retire the loaded image by rename before promoting a validated replacement.
<!-- Prevent wb command fallback from coupling the standalone orchestrator to the app server. -->
- Run Workbench CLI and MCP commands in the standalone orchestrator. Never route them through the app server.

## Managed instructions

- Codex start, resume, and fork rebuild one compact thread-owned Workbench payload from current sources. Unchanged sources and selections must produce identical payloads.
- That payload owns one precedence-resolved self-closing skill catalog. Fresh slash-activated bodies travel only in a UI-hidden `<wb:activated-skills>` item on the triggering user input, never through native skill input or turn context.
<!-- Prevent hidden instruction text from bypassing user ownership. -->
- Keep live Workbench-owned instruction Markdown editable in the Workbench Library. Internal Markdown folders contain only instruction payloads. Every current internal Markdown path mirrors its emitted path. Generated bases refresh on instruction use; retired bases may remain. Active `AGENTS.md` loads only its recursive import graph. Adjacent `X.override.md` replaces `X.md` at every hop.

## Codex turn start

<!-- Prevent split lifecycle owners from starting a turn with stale thread-prefix instructions. -->
- One Codex bridge owner serializes fresh and existing-thread activation.
- A fresh thread uses `thread/start`, MCP preparation, then its first native `turn/start`. It does not resume before rollout storage exists.
- An existing inactive thread uses `thread/unsubscribe`, prefix-bearing `thread/resume`, MCP preparation, then native `turn/start`.
- Only that owner sends `thread/unsubscribe`, `thread/resume`, or native `turn/start`.
- Static reads never call `thread/resume`.
- Active-turn input uses `turn/steer`. It keeps the active turn prefix.
- Recovery and unfinished continuation use the same turn-start owner. They do not rebuild part of its lifecycle.
- Agent and workflow instructions belong in the `thread/resume` prefix, never native turn input.

## Managed turn completion

<!-- Prevent agents from escaping unfinished work through a provider turn boundary. -->
- A normally completed managed turn without pending input or explicit completed/blocked status continues with the hidden unfinished-turn steer.
- User stops, provider failures, restart interruptions, and goal-owned turns never trigger unfinished-turn continuation.

## Relational data shapes

- Store each Workbench-owned semantic shape in typed columns and tables.
- Use JSON only for opaque external values.
- If Workbench reads stored JSON as a known shape, replace that JSON with typed tables.
- Keep base tables small.
- Put type-specific fields in augmentation tables.
- Use one discriminator for each union.
- Use `CHECK` constraints and foreign keys to prevent invalid variants.
- Create each base row and its required augmentation rows in one transaction.
- Do not build one table with unrelated nullable fields.
- Validate old or external data at its boundary.
- Convert accepted data into the current domain type before storage or core use.

## Schema evolution

- Choose stable owners, identities, and extension seams before implementation.
- Prefer compatible schema additions.
- Convert old data at the owning boundary when old and new shapes can coexist.
- Use one focused transactional conversion when the shapes cannot coexist.
- Do not add a general migration framework for one conversion.
- Remove an obsolete schema path when no live or import owner uses it.
- Do not keep dead compatibility code as a speculative fallback.

## Large system replacement

- Build a replacement beside the working system.
- Keep the working system authoritative while the replacement is unproven.
<!-- Prevent replacement recorders from using legacy persistence as their live source. -->
- Seed complete replacement state before mirroring its mutations.
- After that boundary, feed both systems from the fact owner: provider observations or Workbench mutations.
- Do not populate live replacement state by rereading legacy storage.
- Compare semantic results, not storage or implementation shape.
- Exercise comparisons during normal use.
- Move one coherent consumer after it has no unexplained mismatch.
- Remove replaced code when no remaining live or import owner uses it.
- Do not use the old system as a runtime fallback after replacement.
- When one invariant requires an atomic ownership change, prove the full boundary before moving it.
- Do not turn temporary shadow state into permanent architecture.

## Canonical transcript

- Give every supported harness the same transcript guarantees.
- Browser transcript reads use one Workbench first-page and next-page contract.
- Browser page cursors are opaque. Each harness bridge translates them to native paging.
- Store every permanent visible thread item as one row in `thread_items`.
- Use turn indexes to order turns.
- Use item positions to order items within one turn.
- Use item ids, not reusable request keys, as transcript item identity.
- Do not give augmentation tables a second history order.
- Store supported Workbench item shapes in typed tables.
- Store unsupported provider items as opaque unknown items.
- Keep provider-native evidence separate from Workbench items.
- Provider-native evidence does not render or order history.
- Keep durable Browse facts attached to the source operation.
- Treat command presentation as derived and replaceable.
- Rematching can replace presentation.
- Rematching cannot replace the source operation or durable subsystem facts.
