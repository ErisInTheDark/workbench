This file records permanent Workbench requirements.

Search this file for invariants related to the task at hand. Task specs can add stricter temporary rules. They cannot weaken these invariants.

You may propose new invariants or changes to existing invariants, but you must make these proposals PROMINENT, and they must be truly durable invariants that are useful for the project in the longterm.

## Ownership

- Give each durable fact, state, and lifecycle one owner.
- Keep external system details at their adapter boundary.
- Convert external data into shared Workbench types before core code uses it.
- Do not replace an existing owner as part of an additive change.

## Managed instructions

- Codex start, resume, and fork rebuild one compact thread-owned Workbench payload from current sources. Unchanged sources and selections must produce identical payloads.
- That payload owns one precedence-resolved self-closing skill catalog. Fresh slash-activated bodies travel only in a UI-hidden `<wb:activated-skills>` item on the triggering user input, never through native skill input or turn context.

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
