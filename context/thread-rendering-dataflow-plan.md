# Thread Rendering Dataflow Plan

## Goal

Improve very long turn performance by reshaping thread document updates around dataflow instead of manual reapply control flow. The target is a layered model where source changes invalidate derived projections, each layer owns its own cache, and unchanged thread items keep object identity across layers whenever possible.

## Working Principle

Prefer dataflow over control flow: define the data, dependencies, and transformations so changes propagate naturally, instead of manually orchestrating each step.

For thread rendering, this means readers and notification handlers should update layer inputs and revisions. They should not manually replay every dependent transform. The render path should derive one complete renderable thread object after another, with source records, overlay records, preferences, status, and streaming state used only as side inputs and dependency proofs for the layer that owns them.

## End-State Specification Rule

This document specifies the desired end-state architecture. It is not a migration plan, not a wrapper plan, and not an attempt to rationalize whatever code happens to exist today.

Future edits to this document must fully specify the coherent end-state from the dataflow principle before discussing implementation mechanics. The current implementation may be used only as evidence for risks, behavior that must be preserved, or failure modes to prevent. Do not let current shapes define the architecture.

The expected end state is a few deep, maintainable modules with narrow ownership:

- canonical source ownership,
- live streaming reconciliation ownership,
- Workbench overlay ownership,
- visible projection ownership,
- public snapshot/emission ownership.

Each owner defines:

- the source data it accepts,
- the derived data it produces,
- the dependency keys or revisions that decide whether it runs,
- the cache entry it owns,
- the structural-sharing guarantees it preserves,
- the exact downstream invalidations it emits.

If an implementation still allows a turbo-turn profile to look almost identical to the old profile, the implementation has failed this specification. Specifically, ordinary selected-thread materialization, canonical reads without live streaming state, completed-history refresh, screenshot refresh, and overlay-only updates must not be able to enter whole-turn streaming duplicate pruning or whole-turn streaming text normalization.

The architecture must make that failure mechanically difficult, not merely rely on callers remembering the right boolean or branch. Expensive transforms must live only behind the owner whose source data can prove they are needed.

## Complete Thread Transform Rule

Each layer after canonical materialization is a transformation from one complete renderable thread object to another complete renderable thread object. Layers are not managers that own disconnected fragments of the thread.

The canonical layer is the only source-materialization exception: it receives raw canonical input and produces the first complete canonical renderable thread. Every later runtime layer receives the prior complete thread and returns a complete thread.

The cache owned by each layer stores the complete thread object produced by that layer. A layer may maintain indexes, dependency signatures, produced synthetic item indexes, or dirty-turn metadata to decide whether it must run, but those are cache mechanics, not the layer's rendered output.

The render path should be inspectable as a pipeline:

1. canonical renderable thread,
2. live-reconciled renderable thread,
3. Workbench-overlay renderable thread,
4. final visible renderable thread,
5. public snapshot containing final visible renderable threads.

After canonical materialization, every stage receives a complete thread and returns a complete thread. If a layer has no work, it returns the exact previous complete thread object from its cache. If a layer changes only one turn or top-level field, it still returns a complete thread object while preserving all unchanged object identities inside it.

This rule is the point of the layered approach: the system should be easy to inspect by looking at the complete thread after each transformation, while still being fast because each layer can skip work or preserve references from its cached complete output.

## Non-Negotiable Performance Invariants

- Canonical source updates do not run live streaming duplicate pruning.
- Visible projection updates do not run live streaming duplicate pruning.
- Workbench overlay updates do not run live streaming duplicate pruning.
- Public snapshot emission does not deep-compare whole turbo-turn snapshots.
- Public emission paths do not deep-compare `turns`, turn `items`, or item objects to decide whether a turbo-turn snapshot changed.
- The canonical layer receives raw canonical input and produces the first complete renderable thread object; every later runtime layer receives and produces a complete renderable thread object.
- Each layer's primary cache value is the complete renderable thread object it produced.
- A layer may not clone the thread, `turns`, a turn, an `items` array, or an item unless that layer's output for that exact object changed.
- A layer must return its previous cached output when its dependency keys/revisions are unchanged.
- Live streaming reconciliation is the only layer allowed to call streaming text normalization for duplicate compatibility.
- Live streaming reconciliation must prove a turn has live streaming state before inspecting that turn's items for duplicate pruning.
- Questionnaire and steer overlay projection must not inspect `items` for turns outside changed entry turns, previously produced synthetic turns, and live/base-changed turns after initial synthetic-marker index construction.
- Completed full turns with no live streaming state are pass-through values for live reconciliation.
- If a future implementation relies on a generic option such as `pruneStreamingDuplicates`, `applyOverlays`, or `skipProjection` to preserve these invariants, it does not satisfy this spec.

## Replacement Requirement

This plan is for a coherent replacement, not a staged migration. Do not implement this as a long sequence of partial runtime states where half the client treats `ThreadPayload` as source data and the other half treats it as projected visible data.

The final implementation may be coded in an internally ordered way, but the approved behavior change should land as one coherent replacement where:

- all source writes update explicit layer inputs and revisions,
- live reconciliation receives a complete canonical renderable thread plus live-safe streaming state, not projected visible records,
- Workbench overlays receive a complete live-reconciled renderable thread plus overlay sources,
- public `currentThread` and `threadDocuments` snapshots remain visible/projected `ThreadPayload` values,
- synthetic overlay items never become canonical source items,
- completed-history refreshes update overlay sources and trigger projection, not manual replay through streaming prune,
- the old thread ordering and anchor semantics are preserved.

If an implementation cannot satisfy this replacement boundary in one coherent approved patch, stop and re-brief the replacement design instead of landing a partial migration.

## Current Problem Shape

`WorkbenchThreadClient` currently routes many updates through `normalizeThreadDocument`. That function performs several conceptually different transformations in one pipeline: canonical item normalization, stable metadata merging, persisted questionnaire/steer/screenshot overlays, optimistic user-message overlays, and streaming duplicate pruning.

This makes overlay-only updates expensive. Completed questionnaire, steer, and browse screenshot history refreshes can reapply the current thread through the full normalization pipeline, which may scan a turbo turn and call streaming duplicate pruning even though no streaming item reconciliation is needed.

The visible performance symptom is repeated flamegraph stacks like `readCompleted...History -> reapplyCurrentThread...History -> upsertThreadDocument/setCurrentThread -> normalizeThreadDocument -> pruneThreadStreamingDuplicates -> normalizeStreamingText`.

## Desired Layer Model

### Canonical Document Layer

Input: raw app-server reads, transcript hydration, draft materialization output, and stored turn history for one thread document key.

Output: a complete canonical renderable `ThreadPayload` for that key. The output is renderable because it has full thread/turn/item structure, but it contains no Workbench synthetic questionnaire, steer, screenshot, optimistic, or waiting/status overlay items.

Ownership: canonical transcript structure, generic item IDs, duplicate durable item normalization, canonical metadata preparation, canonical anchor semantics, and the “generic snapshot reasoning/context-compaction item can be repaired against a canonical owner” behavior.

Stable preference fallback is not canonical preparation. The canonical layer may expose real canonical values only; Workbench fallback values for model, reasoning effort, service tier, agent identity, and stored token usage belong exclusively to the Workbench overlay layer.

Cache shape: cache by thread document key, canonical input revision/signature, and canonical normalization rules revision. The cache value is the complete canonical renderable thread object. If the raw canonical input for a turn did not change, this layer must preserve that turn object and its item objects from the previous canonical output.

Forbidden work: this layer must not apply Workbench overlays, optimistic user messages, waiting-on-user-input status, stable preference fallbacks, or streaming duplicate pruning.

### Live Streaming Reconciliation Layer

Input: the complete canonical renderable thread object from the canonical layer plus live-safe streaming state for the same thread document key.

Output: a complete live-reconciled renderable `ThreadPayload`. If no live streaming state exists for the thread or affected turns, the output is exactly the canonical thread object from the previous layer.

Ownership: client-created streaming placeholders, canonical/live item replacement, partial item merging, duplicate streaming pruning, replaced-key cleanup, `forgetReplacedStreamingItem`, `forgetStreamingItemKey`, structural item matching, context-compaction lifecycle repair, `mergeWorkbenchThreadTurnBodies`, `mergeLiveStreamingTurn`, and every mutation of client-created streaming item key state.

`normalizeStreamingText` belongs only here because it supports partial/canonical streaming compatibility when text chunking or whitespace differs.

Cache shape: cache by thread document key, canonical layer output revision/reference, live streaming revision, and per-turn live-state revisions. The cache value is the complete live-reconciled renderable thread object. Per-turn item indexes are allowed only as cache mechanics for proving whether reconciliation is needed; they are not the layer output.

No-work rule: for a completed turn with no client-created streaming items, no active live placeholder, no in-progress/live mismatch, and no canonical replacement for a known live item, return the canonical turn object without reading its `items` array.

Forbidden work: this layer must not see Workbench synthetic questionnaire, steer, screenshot, optimistic, or waiting/status overlay output. It must not run from public `state.currentThread` or from `ThreadDocumentStore`, because those are final visible outputs.

### Workbench Overlay Layer

Input: the complete live-reconciled renderable thread object plus Workbench overlay sources for the same thread ID/document key.

Output: a complete Workbench-overlay renderable `ThreadPayload`.

Ownership: questionnaire history, steer history, browse screenshot entries, optimistic user messages, waiting-on-user-input status, thread status repairs that are UI-visible but not canonical transcript facts, and stable preference fallbacks for model/reasoning/service tier/agent/token usage. These are Workbench presentation/recovery overlays, not canonical transcript facts.

Stable preference/status, questionnaire, steer, screenshot, and optimistic projection are ordered subpasses inside one overlay-layer cache entry. They must not become separate public/runtime layers with independent output ownership.

Cache shape: cache by thread document key, live layer output revision/reference, overlay source revisions, stable preference revision, status revision, and produced synthetic item indexes. The cache value is the complete Workbench-overlay renderable thread object.

Turn-targeted rule: questionnaire and steer overlays may inspect only changed entry turns, previously produced synthetic turns, and live/base-changed turns once the produced synthetic item index exists. Missing produced indexes do not permit a full text scan of all turbo-turn items. The first projection after missing produced indexes may perform a bounded synthetic-marker cleanup pass only over turns identified by overlay entry anchors, source dirty metadata, live/base-changed turns, or an index of known Workbench synthetic markers owned by the overlay/deprojection boundary.

Top-level-only rule: browse screenshot changes, stable preference changes, and status changes may produce a new complete thread object, but they must preserve the previous `turns` array when no turn-local value changed.

Forbidden work: this layer must not run live streaming duplicate pruning, `normalizeStreamingText`, canonical item repair, or any transform that treats synthetic overlay items as durable transcript input.

### Visible Projection Layer

Input: the complete Workbench-overlay renderable thread object plus public selection/materialization metadata for the thread document key.

Output: the complete final visible renderable `ThreadPayload` consumed by the UI and public document snapshot. This layer should usually be an identity/stabilization layer, because most visible fields are already settled by the Workbench overlay layer. It exists to own public emission readiness, selected-thread materialization, and final reference stability.

Cache shape: cache by thread document key, overlay layer output revision/reference, selected-key revision, public materialization revision, and any final UI-only visibility revision. The cache value is the complete final visible renderable thread object. If no dependency changed, return the previous final visible thread reference.

Forbidden work: this layer must not apply questionnaire, steer, screenshot, optimistic, status, stable preference, canonical normalization, or live streaming reconciliation transforms. If this layer grows meaningful transform logic, the spec must name that logic and prove why it does not belong to one of the earlier complete-thread layers.

Hard input invariant: each visible projection input is the prior layer's complete output plus final public materialization metadata. A later layer must never re-run a previous layer over its own projected output.

## Structural Sharing Rules

- Do not deep-clone turns or items as a default.
- Return the same thread object when no projected value changed.
- Return the same `turns` array when no turn changed.
- Return the same turn object when no turn-local value changed.
- Return the same `items` array when no item insertion, removal, reorder, or replacement occurred.
- Return the same item object when the item content is unchanged.
- When adding synthetic overlay items, create only those new items and a new array for the affected turn.
- When removing synthetic overlay items, create a new array for the affected turn but preserve all surviving item objects.
- Keep canonical items and synthetic overlay items distinguishable so synthetic items do not become durable canonical input.

## Data Sources

These are source inputs, not rendered layer outputs. A source may expose records, revisions, dirty keys, produced synthetic indexes, or equality helpers, but the render path between layers is still complete thread object to complete thread object.

- Canonical thread reads and hydration payloads feed the canonical document layer.
- Live Codex/OpenCode notification deltas, live placeholders, completed item snapshots, and client-created item key state feed the live streaming reconciliation layer.
- Stored Workbench histories feed the Workbench overlay layer: questionnaire history, steer history, and browse screenshot entries.
- Optimistic local user-message state feeds the Workbench overlay layer.
- Stable local preferences feed the Workbench overlay layer: model, reasoning effort, service tier, agent path/nickname/role, and stored token usage.
- Thread status and waiting-on-user-input state feed the Workbench overlay layer.
- Selection and public materialization state feed the visible projection and public snapshot layers.

## Thread Document Key Contract

`ThreadDocumentKey` is the resolved Workbench document-store key for a concrete thread document. It is currently produced by `createThreadDocumentKey(harness, threadId)` and `createThreadDocumentKeyForThread(thread)` in `webapp/lib/workbench/thread/thread-document-keys.ts`. It is the key used by private layer inputs, every layer cache entry, public materialized documents in `ThreadDocumentStore`, and selected-key mirrors.

Thread ID is lookup data, not the primary cache key when ambiguous. A thread ID may map to a document key, but source records, layer caches, final visible materialization, and public snapshot entries must use the resolved `ThreadDocumentKey` so harness, subthread, branch, or collaboration distinctions cannot collide.

If implementation discovers that the current store key is not already a stable resolved document identity, the source plan must stop and define the replacement key before editing source behavior. Do not silently use plain thread ID as a substitute cache key.

## Source Write API Contract

Every old reader, notification handler, setter, or lifecycle method must be routed to one of these write surfaces. These methods are planning names, but the implementation must provide equivalent owner-specific methods instead of updating source records ad hoc.

| Source write surface | Owning layer/input | Required no-change behavior |
| --- | --- | --- |
| `writeCanonicalInput(key, rawThread, reason)` | Canonical raw input record. | Normalize/record canonical input identity and bump canonical input revision only when the raw canonical payload or canonical metadata meaningfully changes. Stable preference fallbacks do not bump this revision. |
| `writeLiveSourceDelta(key, delta, reason)` | Live streaming source record. | Bump live revision or affected turn revision only when client-created keys, live placeholders, completed item snapshots, replacement mappings, or live-visible turn metadata change. |
| `writeOverlayHistorySource(key, threadId, entries, reason)` | Questionnaire, steer, screenshot, and optimistic overlay source records. | Use `key` as the primary source/cache owner and `threadId` only as lookup/display metadata. Bump only the relevant overlay revision when entries differ by explicit field comparison or an approved equality helper. Forced questionnaire replay increments only `questionnaireForceProjectionEpoch`. |
| `writeStablePreferenceSource(key, preferences, reason)` | Stable preference source record consumed by the Workbench overlay layer. | Always record explicit stable preference setter values so fallback state remains current for future canonical-missing projection. Bump stable preference projection revision only when the visible fallback output changes. |
| `writeStatusSource(key, status, reason)` | Visible status/waiting source record consumed by the Workbench overlay layer and thread-summary updater. | Bump status revision only when the visible status or waiting-on-user-input state changes. Summary update input comes from this same source change. |

“Meaningfully changes” must be owned by the source writer, not by a downstream layer. Use explicit field comparisons or existing deep equality helpers for JSON-like data; do not use `JSON.stringify` as an equality check.

Comparator requirements:

- Canonical input comparison must produce per-turn canonical signatures or revisions so a fresh raw payload object with equivalent completed turn content does not force unchanged completed turns through item normalization.
- Questionnaire history comparison must include request key, thread/turn placement, anchor metadata, response content, and completion/sent status fields used by rendering.
- Steer history comparison must include entry key, thread/turn placement, input content, status, created/updated ordering fields used by rendering, and any marker text/images used for display filtering.
- Browse screenshot comparison must include every visible `WorkbenchBrowseScreenshotEntry` field and preserve the previous entry array when entries are equivalent.
- Optimistic user-message comparison must include turn key, item ID, placement, input content, status, and the item object reference when unchanged.
- Stable preference comparison must compare model, reasoning effort, service tier, agent path, agent nickname, agent role, and token usage by explicit fields or existing structural equality helpers.
- Status comparison must compare visible thread status, waiting-on-user-input state, and any summary-facing status fields.

Overlay source keying rule: overlay history reads may start from a bridge/API `threadId`, but they must resolve the affected `ThreadDocumentKey` before mutating overlay source state. If multiple keys could match the same `threadId`, the writer must either update the exact resolved key from the current thread/harness context or stop for a source-plan decision; it must not broadcast overlays across every matching key to be safe.

## Desired Update Flow

1. A reader or notification handler receives new data.
2. It updates the source input owned by exactly one layer and bumps only that source's revision if the meaningful value changed.
3. The render scheduler marks the affected thread document key dirty for the first layer whose inputs changed.
4. The pipeline re-materializes the affected complete thread object through the ordered layers:
   1. raw canonical input -> complete canonical renderable thread,
   2. canonical thread + live source -> complete live-reconciled renderable thread,
   3. live-reconciled thread + overlay/preference/status sources -> complete Workbench-overlay renderable thread,
   4. overlay thread + public materialization metadata -> complete final visible renderable thread,
   5. final visible thread -> public current-thread/store snapshot.
5. Any layer whose dependency keys/revisions are unchanged returns its previous complete output reference.
6. Any layer that changes only top-level metadata returns a new complete thread object while preserving the previous `turns` array.
7. Any layer that changes only one turn returns a new complete thread object and a new `turns` array while preserving all unchanged turn and item references.
8. UI subscribers emit only if the final visible thread reference or public snapshot reference changed.

Completed Workbench history refresh should therefore update overlay source maps and cause at most one overlay projection flush. It should not manually call separate reapply functions for questionnaire, steer, and browse screenshot histories.

Batching rule: multiple source writes for the same `ThreadDocumentKey` during one completed-history refresh must coalesce into one scheduled materialization for that key unless a caller explicitly requests a synchronous flush and the spec names why that synchronous flush is required. Questionnaire, steer, and browse screenshot refreshes that resolve in the same completed-history batch must not each trigger independent selected-thread materialization.

## Render Scheduler Ownership

`ThreadRenderPipeline` owns render scheduling lifecycle state: dirty thread document keys, batch boundaries, materialization queue state, synchronous flush exceptions, reentrancy guards, and race ordering between canonical/live/overlay writes.

Scheduler rules:

- Source writers mark the first affected layer and `ThreadDocumentKey` dirty; they do not call downstream transforms directly.
- Multiple dirty marks for the same key in one microtask/completed-history batch coalesce into one materialization unless the caller uses a named synchronous flush method.
- Synchronous flush is allowed only for paths that immediately need the final visible thread return value, such as selected-thread open/materialization. Completed-history refresh should not use synchronous flush for each individual history source.
- If a canonical read and overlay refresh race for the same key, materialization must use a consistent revision snapshot: canonical -> live -> overlay -> final visible. A newer source write that lands during materialization schedules a follow-up materialization instead of mutating the in-flight layer output.
- Clearing selection, missing canonical input, or removing a thread must atomically update `state.currentThread`, `ThreadDocumentStore.selectedThreadKey`, dirty render keys, and subscriber emissions for that key. Stale projected store documents may remain only if they are intentionally retained as non-selected final visible documents and are not treated as canonical source.
- The scheduler must expose counters or debug hooks usable by validation to assert materialization count per key.

## Canonical Signature Contract

The canonical layer must avoid treating fresh-but-equivalent raw payload objects as changed turbo turns.

- Store canonical signatures/revisions per `ThreadDocumentKey` and per turn ID.
- A turn signature must be computed from explicit canonical fields that affect canonical render output: turn ID, turn status/kind metadata, item count/order, item IDs, item types, item role/kind metadata, and item content references or content revision fields already present in the raw payload.
- Signature computation must preserve the prior signature when the raw turn object reference is unchanged.
- Equivalent refresh validation must use counters or hooks to prove signature computation does not scan all item text for every completed turbo turn on every read.
- If an item lacks a cheap content revision/reference needed for equality, the source implementation plan must name the bounded comparison rule before source edits. Do not fall back to whole-turn text serialization or `JSON.stringify`.
- A changed top-level canonical thread field must not force unchanged completed turn item normalization.

## Layer Cache Proof Obligations

Each layer must define a cache entry and a no-work predicate.

### Canonical source cache

Cache key: thread document key plus canonical source revision. Cache value: the complete canonical renderable thread object.

No-work predicate: the canonical input payload reference/signature for the thread did not change. The layer returns the previous canonical thread object. It does not apply Workbench overlays, does not inspect optimistic state, and does not run live streaming duplicate pruning.

Per-turn canonical no-work predicate: fresh raw payload objects with equivalent per-turn canonical content must not force unchanged completed turns through item normalization. The canonical layer cache must compare per-turn canonical signatures/revisions before rebuilding turn objects, `items` arrays, or item objects.

### Live reconciliation cache

Cache key: thread document key, canonical source revision, live streaming revision, and per-turn live-state revision. Cache value: the complete live-reconciled renderable thread object.

No-work predicate: no live streaming source changed and the canonical revision for live-affected turns did not change. The layer returns the previous reconciled live thread object.

Turn no-work predicate: the turn has no client-created streaming items, no active live placeholder, no in-progress/live mismatch, and no canonical replacement for a known live item. The layer returns the canonical turn object without reading its `items` array.

### Workbench overlay cache

Cache key: thread document key, live layer output revision/reference, overlay source revisions, stable preference revision, status revision, and produced synthetic item index. Cache value: the complete Workbench-overlay renderable thread object.

No-work predicate: overlay source revisions, stable preference revision, status revision, and live layer output revision are unchanged. The layer returns the previous complete Workbench-overlay output. For turn-targeted overlays, it may inspect only changed entry turns, previously produced synthetic turns, and live/base-changed turns.

### Final visible layer cache

Cache key: thread document key, Workbench overlay layer output revision/reference, selected-key revision, public materialization revision, and public metadata revision. Cache value: the complete final visible renderable thread object.

No-work predicate: all dependency keys match. The layer returns the previous complete final visible `ThreadPayload` reference.

### Public snapshot cache

Cache key: document key map identity, selected key, and final visible document references.

No-work predicate: no final visible document reference, selected key, or key map changed. The layer returns the previous `WorkbenchThreadDocumentSnapshot` reference and emits nothing.

## Flamegraph Acceptance Criteria

The replacement is not acceptable until profiling or focused instrumentation proves:

- Opening an already completed turbo turn does not call whole-thread `pruneThreadStreamingDuplicates`.
- Opening an already completed turbo turn does not call whole-turn `pruneDuplicateStreamingItems` for completed turns without live state.
- Opening an already completed turbo turn does not call `normalizeStreamingText` unless the opened thread has live streaming state that requires text compatibility.
- Completed questionnaire, steer, and browse screenshot history reads do not call streaming duplicate pruning or streaming text normalization.
- Overlay-only updates do not walk every item in unaffected turns.
- Public snapshot emission does not deep-compare whole turbo-turn snapshots.

If a profile after the replacement still shows `openThread`, `fetchThreadPayload`, completed-history reads, or overlay refresh flowing into streaming duplicate pruning for completed non-live turns, the implementation fails this specification.

## Semantic Equivalence Contract

The replacement must match current user-visible semantics except where this document explicitly says the current performance behavior changes. This table is the proof checklist for the old ordering bugs.

| Current semantic | Current owner/path | Replacement semantic |
| --- | --- | --- |
| Canonical thread item anchors are preserved; unrelated canonical reasoning IDs are not collapsed just because text matches. | `normalizeThreadItems`, `mergeDuplicateNormalizedThreadItem`, `ADR-0002`. | Canonical source normalization must continue using `normalizeThreadItems` semantics. Live streaming pruning must not run over unrelated completed canonical reasoning IDs. |
| Generic snapshot reasoning/context-compaction items can be repaired/deduped against canonical owners. | `normalizeThreadItems`, context-compaction lifecycle merge helpers. | Canonical source preparation keeps the same generic-ID repair rules before projection. |
| Partial live streaming placeholders can be replaced by canonical completed/snapshot items. | `clientCreatedStreamingItemKeys`, `upsertThreadItem`, `mergeLiveStreamingThreadSnapshot`, `pruneDuplicateStreamingItems`. | Live reconciliation source owns the same placeholder/canonical replacement semantics and remains the only place `normalizeStreamingText` is used for streaming compatibility. |
| State-change `<set-state ... />` items have special duplicate matching rules. | `isThreadStateChangeLikeAgentMessage`, `areThreadStateChangeItemsCompatible`, `canPruneDuplicateStreamingItems`. | Live reconciliation preserves these special rules exactly. |
| Questionnaire history appears near the requested/anchor item when possible and defers when anchor metadata cannot be resolved. | `applyQuestionnaireHistoryToThread`. | Projection calls questionnaire overlay with the same entries, same `itemsView`, and same base items after canonical/live reconciliation. |
| Questionnaire overlay strips stale synthetic questionnaire items, redundant persisted question tool calls, and Workbench synthetic steer user messages. | `stripQuestionnaireHistoryOverlayItems`. | Projection order keeps questionnaire before steer/optimistic overlays so this strip behavior cannot remove newly projected steer/optimistic items. |
| Steer history adds synthetic user messages only when canonical user messages do not already represent the steer. | `applySteerHistoryToThread`, `shouldRenderSteerHistoryEntry`. | Projection applies steer overlay after questionnaire overlay with the same canonical base visibility rules. |
| Browse screenshot entries are top-level thread metadata, not turn item mutations. | `applyPersistedBrowseScreenshotEntries`. | Projection updates `browseScreenshotEntries` without changing `turns` when screenshot entries are the only changed source. |
| Optimistic user messages appear while canonical user messages are unresolved and disappear once canonical/synthetic equivalents exist. | `applyOptimisticUserMessageOverlay`, optimistic maps. | Projection applies optimistic overlay last and uses existing optimistic entry item objects where possible. |
| Waiting-on-user-input status appears on the current thread and thread summary. | `markThreadWaitingOnUserInput`, `clearThreadWaitingOnUserInputFlag`. | Waiting state becomes a source/status input projected into visible current thread and summaries without turning projected payloads into canonical source. |
| Public UI consumers receive visible/projected `ThreadPayload` documents. | `state.currentThread`, `threadDocuments.getSnapshot()`, `getThreadDocumentFromSnapshot`. | Public `currentThread` and `WorkbenchThreadDocumentSnapshot` remain visible/projected outputs. Source records are private. |
| Completed-history refresh can force questionnaire projection even when entries are unchanged and non-empty. | `readCompletedQuestionnaireHistory` with `entries.length`. | `questionnaireForceProjectionEpoch` forces projection cache invalidation while preserving the historical compaction fix. |
| Completed-history refresh currently may accidentally run streaming prune. | `reapplyCurrentThread...History -> normalizeThreadDocument -> pruneThreadStreamingDuplicates`. | This is intentionally changed: completed-history refresh updates overlay sources and projection only; it does not run streaming duplicate pruning. |

## Failure Modes The End State Must Make Impossible

This table records old/current failure modes only so the end-state architecture can prevent them. It is not an implementation map and must not be used as a reason to preserve current ownership.

| Old/current caller or function | Old/current behavior | Dataflow failure | Required end-state property |
| --- | --- | --- | --- |
| `fetchThreadPayload` | Reads a thread, starts completed Workbench history reads, converts to `ThreadPayload`, merges live streaming snapshot, then calls `normalizeThreadDocument`. | Canonical ingestion plus live reconciliation. | Write canonical read result into canonical source, run live reconciler only when selected thread has live state, then invalidate projection. Do not synchronously replay completed-history overlays from the reader. |
| `readCurrentThread` | Reads the selected thread, starts completed Workbench history reads, merges live streaming snapshot, then calls `normalizeThreadDocument`. | Canonical ingestion plus live reconciliation. | Same as `fetchThreadPayload`, but scoped to selected thread. |
| `readThread` | Uses fetched payload, then calls `setCurrentThread` or `upsertThreadDocument`. | Canonical ingestion and/or selection update. | Write source document, then select thread if needed. Projection should derive the visible selected thread. |
| `openThread` | Fetches payload and calls `setCurrentThread`. | Selection update after canonical ingestion. | Select source document key; projection updates selected visible thread. |
| `selectThreadPayload` | Calls `setCurrentThread` with an existing payload. | Selection update. | Select existing document key; avoid re-normalizing if source revisions did not change. |
| `reconcileCurrentThreadFromRead` | Reads selected thread and calls `setCurrentThread`. | Canonical refresh for selected thread. | Update canonical source and live reconciliation source, then invalidate selected projection. |
| `setCurrentThread` | Normalizes, upserts into `ThreadDocumentStore`, marks seen, assigns `state.currentThread`, emits, and refreshes rate limits. | Mixed projection write, selection, unread side effect, and lifecycle scheduling. | Replace with `setSelectedThreadKey` plus projection flush into public projected outputs. Keep mark-seen and rate-limit scheduling as explicit side effects after selected projection changes. |
| `upsertThreadDocument` | Normalizes and writes a visible-looking document into `ThreadDocumentStore`. | Mixed source write and projection write. | Replace with private canonical/live source writes plus projection flush into the public projected `ThreadDocumentStore`. Do not use `ThreadDocumentStore` as canonical source. |
| `normalizeThreadDocument` | Applies canonical normalization, stable metadata, stored token usage, all Workbench overlays, optimistic overlay, then optional streaming prune. | Overloaded transformation pipeline. | Replace with named lifecycle functions. No caller should call a generic all-in-one function after the replacement. |
| `mergeLiveStreamingThreadSnapshot` and `mergeLiveStreamingTurn` | Merge canonical snapshot with current live items and prune duplicate streaming items. | Live streaming reconciliation. | Move behind `ThreadStreamingReconciler`. It may use `normalizeStreamingText`. |
| `updateTurnItems` | Updates one turn, optionally prunes duplicate streaming items locally, then updates current thread without a second global prune. | Live streaming mutation. | Route through the live reconciliation owner in the replacement. It remains a live source mutation and must not trigger global projection normalization. |
| `upsertThreadItem` | Merges item snapshots/completed items, resolves client-created placeholders, and prunes duplicates. | Live streaming reconciliation. | Keep pruning here. This is one of the places where duplicate streaming reconciliation belongs. |
| `updateOrCreateThreadItem` | Creates or updates client-side streaming placeholder items and marks client-created item keys. | Live streaming source update. | Keep under streaming reconciler. Must not trigger global projection normalization beyond affected turn. |
| `updateThreadItem` | Updates an existing item such as command output or file patch. | Live item update without duplicate creation. | Keep no-prune semantics. Update affected turn source and invalidate affected projection. |
| `readCompletedQuestionnaireHistory` | Fetches questionnaire history, updates history map, and may call `reapplyCurrentThreadQuestionnaireHistory`, including forced reapply when entries are non-empty. | Workbench overlay source update. | Only update questionnaire overlay source and return whether overlay revision changed or forced replay is needed. Projection flush applies overlays once. Preserve forced replay semantics through `questionnaireForceProjectionEpoch`. |
| `readCompletedSteerHistory` | Fetches steer history, updates history map, and calls `reapplyCurrentThreadSteerHistory` on changes. | Workbench overlay source update. | Only update steer overlay source and return whether overlay revision changed. Projection flush applies overlays once. |
| `readBrowseScreenshotEntries` | Fetches screenshot entries, updates screenshot map, and calls `reapplyCurrentThreadBrowseScreenshotEntries` on changes. | Workbench overlay source update. | Only update screenshot overlay source and return whether overlay revision changed. Projection flush applies top-level screenshot entries without touching turns. |
| `readCompletedThreadWorkbenchHistory` | Runs the three completed-history readers in parallel, but each reader currently owns replay. | Batched overlay source refresh. | Run the three source reads in parallel with replay disabled, then invalidate projection once if any source changed or forced replay is required. |
| `recordLocalQuestionnaireHistoryEntry` for OpenCode | Writes local questionnaire history and immediately reapplies questionnaire overlays. | Local overlay source update. | Update questionnaire overlay source and invalidate projection for that thread. |
| `refreshCurrentThreadOptimisticUserMessages` | Calls `updateCurrentThread` with `applyOptimisticUserMessageOverlay`. | Optimistic overlay source update. | Update optimistic overlay source status, then invalidate projection. Avoid applying overlay by mutating visible thread payload directly. |
| `clearThreadWaitingOnUserInputFlag` and `markThreadWaitingOnUserInput` | Directly mutate `state.currentThread.status`, upsert that visible thread into documents, and update thread summaries. | Top-level metadata/status source update. | Update status source for the thread and summary. Projection derives visible status. Do not mutate projected thread and store it as source. |
| `setCurrentThreadServiceTier`, `setDraftThreadHarness`, model/reasoning/agent setters | Use `updateCurrentThread` to rewrite top-level current-thread fields. | Stable preference/top-level metadata source update. | Update stable preference/source maps, invalidate selected projection, and preserve turns by reference. |
| `sendThreadMessage` | Mixes draft materialization, canonical reads, optimistic overlays, live resume reads, completed-history reads, and final `setCurrentThread`/`upsertThreadDocument`. | Orchestrated workflow combining source updates. | Keep workflow orchestration for network calls, but each result should update a source layer. Projection should handle visible state after each source update. |
| `stopThread`, `pauseThread`, `clearThreadTokenUsage` paths | Perform command, read refreshed thread, then call `setCurrentThread` or update fields. | Canonical refresh plus metadata source update. | Write canonical refresh or metadata source, then invalidate projection. |

## Layer Inputs, Dependencies, And Complete Cached Outputs

The end state must make source changes explicit without turning sources into rendered fragments. Each layer has side inputs and dependency keys, but its primary cached value is always the complete renderable thread object it produced.

| Layer | Required primary input | Side inputs / source records | Revision trigger | Complete cached output |
| --- | --- | --- | --- | --- |
| Canonical document layer | Raw canonical payload for one thread document key. | Hydration payloads, app-server read payloads, draft materialization results, canonical normalization rules. | New thread read, hydration payload, draft materialization, or canonical metadata refresh changes meaningful canonical input. | Complete canonical renderable `ThreadPayload` with durable transcript items only. |
| Live streaming reconciliation layer | Complete canonical renderable thread from the canonical layer. | Streaming placeholders, item deltas, completed item snapshots, client-created item keys, replaced-key cleanup state, per-turn live revisions. | Streaming item placeholder added, item delta received, item completed, snapshot merge changes live state, turn metadata update changes live-visible data. | Complete live-reconciled renderable `ThreadPayload`; equal to canonical thread reference when no live reconciliation work exists. |
| Workbench overlay layer | Complete live-reconciled renderable thread from the live layer. | Questionnaire history, questionnaire force epoch, steer history, browse screenshot entries, optimistic user-message entries, stable preferences, visible status/waiting state, produced synthetic item index. | Any overlay/preference/status source changes, or forced questionnaire replay epoch increments. | Complete Workbench-overlay renderable `ThreadPayload`. |
| Visible projection layer | Complete Workbench-overlay renderable thread from the overlay layer. | Selection state, public materialization reason, final UI-only visibility metadata if any. | Selected key changes, materialization request for a displayed non-selected thread, or final UI-only visibility metadata changes. | Complete final visible renderable `ThreadPayload`. |
| Public snapshot layer, implemented concretely by `ThreadDocumentStore` | Complete final visible renderable thread objects for materialized keys. | Public key maps, selected key mirror, store subscriber revision. | A materialized final visible thread reference changes, selected key mirror changes, or key map changes. | `WorkbenchThreadDocumentSnapshot` containing final visible renderable thread objects. |

Each source should expose either a numeric revision or enough identity-stable values for layer caches to test whether work is needed. Do not use `JSON.stringify` signatures for equality. Use explicit revisions or existing equality helpers.

## Complete Thread Layer Cache Contract

Every layer cache entry must store the same minimum shape:

- the thread document key,
- the input complete thread reference or raw canonical input reference,
- dependency revisions/signatures for that layer's side inputs,
- the complete `ThreadPayload` output produced by that layer,
- optional proof metadata such as dirty turns, produced synthetic item IDs, changed turn IDs, or previous top-level references.

Layer cache rules:

1. If every input reference/revision for a layer matches the previous cache entry, return the previous complete `ThreadPayload` output reference for that layer.
2. If only top-level metadata changed, return a new complete thread object with the previous `turns` array.
3. If only screenshot entries changed, return a new complete overlay/final thread object with the previous `turns` array.
4. If one turn changed, return a new complete thread object and a new `turns` array, but preserve every unchanged turn object.
5. If synthetic items are inserted or removed in one turn, return a new `items` array for that turn but preserve all unchanged item objects.
6. If canonical/live reconciliation changes one turn item, preserve all other turn and item references.
7. Do not feed a later layer's output back into an earlier layer. Final visible threads must never enter canonical normalization or live reconciliation.
8. Do not run questionnaire/steer overlay transforms over every turn when dirty turn metadata, produced synthetic indexes, or bounded synthetic-marker indexes identify a smaller affected set.
9. Do not expose a layer whose primary returned value is a fragment, patch list, mutation callback, or manager state. Fragment/index data is allowed only as proof metadata beside the complete cached output.

## Overlay Projection Order And Synthetic Ownership

Projection order inside the Workbench overlay layer must preserve the current effective behavior unless a later approved plan changes it.

Current effective order from `normalizeThreadDocument`:

1. Canonical normalization and currently mixed stable fallback.
2. Questionnaire history overlay.
3. Steer history overlay.
4. Browse screenshot top-level overlay.
5. Optimistic user-message overlay.
6. Streaming duplicate prune.

Target complete pipeline and overlay subpass order after streaming prune leaves overlay replay:

1. Canonical source preparation.
2. Live streaming reconciliation.
3. Workbench overlay layer subpasses:
   1. Stable preference and visible status fallback.
   2. Questionnaire history overlay.
   3. Steer history overlay.
   4. Browse screenshot top-level overlay.
   5. Optimistic user-message overlay.

Important invariant: `applyQuestionnaireHistoryToThread` currently strips synthetic questionnaire items, redundant persisted questionnaire tool-call items, and Workbench synthetic steer user messages. This means questionnaire projection must run before steer and optimistic projection, or it can remove synthetic steer/optimistic items that were just projected. Do not reorder these overlays without rewriting the strip rules.

Overlay target resolution:

- Questionnaire entries target the entry's resolved turn ID when present.
- If questionnaire anchor metadata is missing, delayed, compacted, repaired, or ambiguous, the overlay source must record the unresolved/ambiguous state and retry only the entry's candidate turns plus previously produced synthetic turns when base/live content changes.
- Steer entries target the entry turn ID returned by the bridge/history source. If the acknowledged turn changes, the overlay source must mark both the old and new turn dirty.
- Entry deletion marks the deleted entry's previous target turn and any turn that previously contained a synthetic item for that entry dirty.
- Moved anchors mark the old anchor turn, new anchor turn, and produced synthetic turn dirty.
- Dirty turn metadata is allowed to be conservative, but it must be turn-scoped. It must not mean “scan every turn in the thread” for a turbo turn unless the source plan explicitly proves the thread is small enough or the operation is outside the turbo-turn render path.

Synthetic item reuse rules:

- Questionnaire synthetic items should reuse the previous synthetic questionnaire item with the same generated ID when the entry content is equivalent, matching the current `collectSyntheticQuestionnaireHistoryItems` behavior.
- Steer synthetic items are currently recreated by `createSyntheticSteerHistoryItem`. A projection cache must either accept that affected steer turns get new synthetic item objects when steer overlay revision changes, or add a per-entry synthetic steer item cache keyed by `entryKey` and equivalent entry content.
- Optimistic user messages should continue using existing `OptimisticUserMessageEntry.item` objects where possible; status changes intentionally create new optimistic items.
- Structural sharing acceptance criteria apply to unchanged canonical items and unaffected turns. Synthetic overlay items may be new when their owning overlay revision changes, but must be stable when the same overlay source revision is reused.

Overlay cleanup ownership rule:

- Each overlay projection cache entry must record which synthetic item IDs and turn IDs it produced.
- A changed questionnaire or steer overlay must project affected turns equal to changed entry turns, previously synthetic overlay turns, and turns whose canonical/live base changed.
- Source dirty sets are invalidation inputs only. Produced synthetic item indexes are output cleanup proof only. They may be cross-checked, but one must not silently substitute for the other.
- Turn-targeted projection is required once produced indexes or bounded synthetic-marker indexes exist. Without a produced index, the overlay layer may run one bounded synthetic-marker cleanup pass as described in the Workbench Overlay Layer section, but it must not scan all item text in huge completed turns.
- This is especially important because questionnaire projection strips synthetic questionnaire items, redundant persisted question tool calls, and synthetic steer user messages.

Synthetic marker index ownership:

- The Workbench overlay/deprojection boundary owns Workbench synthetic marker knowledge.
- Canonical and live reconciliation layers must not inspect Workbench synthetic marker semantics and must not build Workbench synthetic-marker indexes.
- The marker index may be built from known synthetic ID prefixes/guards such as `isSyntheticQuestionnaireHistoryItem`, `isSyntheticSteerHistoryItem`, `isWorkbenchSyntheticSteerUserMessage`, and the optimistic user-message ID prefix, but only inside overlay/deprojection ownership.
- Building the marker index must itself obey the performance invariant: it may inspect candidate turns identified by overlay sources, produced indexes, dirty turns, or deprojection startup boundaries, but it must not scan all item text in unrelated huge completed turns.

## Forced Questionnaire Projection

The current `readCompletedQuestionnaireHistory` replays when `setQuestionnaireHistoryEntries(...)` changes or when `entries.length` is non-zero. Git history ties the `entries.length` forced replay to compaction duplicate-message fixes.

A projection cache that only checks `questionnaireRevision` would accidentally skip forced replay when entries are unchanged but non-empty. Therefore the overlay source must include `questionnaireForceProjectionEpoch`, incremented whenever the old code would have called `reapplyCurrentThreadQuestionnaireHistory` because `entries.length` was non-zero. This keeps projection cache comparisons explicit and avoids hidden bypass booleans.

The Workbench overlay layer cache entry must include the epoch. If unchanged entries are non-empty and the epoch increments, the overlay layer must run even when `questionnaireRevision` is unchanged, and it must still return a complete Workbench-overlay renderable thread object.

## Final Visible Read Compatibility Ledger

Do not make `ThreadDocumentStore` source-only in this replacement. It remains the public projected document store for current visible consumers:

| Consumer | Current read path | Required compatibility rule |
| --- | --- | --- |
| `WorkbenchClient.ts` thread document change emission | Deep-compares `threadDocuments` snapshots and emits `onThreadDocumentsChange`. | Overlay-only selected-thread changes should avoid emitting giant store snapshots when possible. Public snapshots remain visible/projected in the replacement. |
| `webapp/components/workbench.tsx` main thread lookup | `getThreadDocumentFromSnapshot(threadDocuments, effectiveThreadId)`. | Must continue receiving projected visible documents from the public snapshot. |
| `ThreadView.tsx` subagent/subthread lookup | `getThreadDocumentFromSnapshot(threadDocuments, threadId)`. | Subthreads must not lose overlays or pending state. |
| Mosaic thread panels | `getThreadDocumentFromSnapshot(threadDocuments, target.threadId)`. | Mosaic must receive projected visible documents from the public snapshot. |
| Collaboration view/run controller | `threadDocuments` prop and `getThreadDocumentFromSnapshot`. | Collaboration run threads must retain visible overlays and current pending state. |
| `getPendingUserInputRequestThread` | `state.currentThread` or `threadDocuments.getDocumentByThreadId`. | Must read projected visible data, because pending user input is a visible UI contract. |

Replacement rule: public `threadDocuments` snapshots stay visible/projected. Private source records are introduced behind `WorkbenchThreadClient`, and public snapshot semantics are not changed by this replacement.

## Public Projection Emission Contract

The replacement has two public projected outputs:

- `state.currentThread`, consumed by selected-thread UI and emitted through current-thread subscribers.
- `ThreadDocumentStore`, exposed as `threadDocuments.getSnapshot()` and consumed by main thread, subthread, mosaic, and collaboration readers.

Ownership boundary:

- `ThreadVisibleLayer` owns final visible `ThreadPayload` reference stability for a single document key.
- `ThreadDocumentStore` is the concrete public snapshot layer. It owns public snapshot container identity, selected-key mirror identity, key maps/order containers, and subscriber emission.
- `WorkbenchThreadClient` coordinates selected-thread materialization and passes complete final visible threads to the public outputs.
- `WorkbenchClient.ts` consumes final visible outputs and may compare layer/public revisions or references, but it must not deep-compare `turns`, `items`, or item objects to prove whether a turbo-turn emission changed.

Selection source rule:

- `WorkbenchThreadClient` owns a private `selectedThreadKey` source value. Selection/opening changes that key first; it does not select by reading or writing a projected payload as source.
- `ThreadDocumentStore.selectedThreadKey` is a public projected selection mirror. It is synchronized only when `materializeFinalVisibleThread(key, { select: true, reason })` flushes a final visible thread into the public store, or when selection is cleared.
- If `ThreadDocumentStore` needs key-only selection for clearing or mirroring, add a method such as `selectDocumentKey(key)` that never requires a payload and never treats stored projected documents as source.

Final visible flush rules:

1. `setProjectedCurrentThread(finalVisibleThread)` is the only operation that assigns `state.currentThread`.
2. Selected-thread projection must keep `state.currentThread` and the public store coherent when both surfaces expose the selected thread. If the selected final visible document differs from the public store entry, flush the same final visible object into `ThreadDocumentStore`.
3. A public store upsert must be skipped when the final visible document reference for that key is unchanged.
4. `ThreadDocumentStore` must preserve snapshot identity and avoid subscriber emission when no stored final visible document reference, selected key, or key index changed.
5. Screenshot-only changes intentionally create a new projected thread object and may emit public current-thread/store changes, because screenshot metadata is visible. They must preserve the previous `turns` array.
6. Overlay-only selected-thread changes may skip a giant `threadDocuments` snapshot emission only if the store entry is unchanged. If the selected public store entry changes, it must emit, but the emitted snapshot should preserve unchanged document, key-map, turn, and item references.
7. `WorkbenchClient.ts` must treat `currentThread` emission and `threadDocuments` emission as separate performance surfaces. Avoiding one does not prove the other is stable.
8. Update or replace both `WorkbenchThreadClient.areThreadPayloadsEquivalent` and `WorkbenchClient.areThreadPayloadsEquivalent` so visible metadata fields, including `browseScreenshotEntries`, participate in selected-thread and store emission decisions. An equivalent replacement is allowed only if it uses projection reference/revision checks that cannot ignore visible screenshot metadata.
9. “At most one selected-thread projection flush” means one pipeline materialization per affected key. That one materialization may legitimately update both `state.currentThread` and `ThreadDocumentStore` if both public surfaces expose the affected final visible thread.

Non-selected materialization rules:

- `materializeFinalVisibleThread(key, options)` runs the complete-thread pipeline for the key and writes the final visible thread into `ThreadDocumentStore`.
- Canonical/background reads that produce or refresh a thread document must call `materializeFinalVisibleThread(key, { reason })` when the thread is selected, opened as a subthread, shown in mosaic, or used by collaboration.
- Selected projection flush uses `materializeFinalVisibleThread(key, { select: true, reason })` so the public store selection mirror is updated with the same final visible object as `state.currentThread`.
- Subthread, mosaic, and collaboration panels continue reading `getThreadDocumentFromSnapshot(threadDocuments, threadId)` and therefore require their visible documents to be present in the public projected store.
- Missing non-selected projected documents must be produced by the complete-thread pipeline from private layer inputs, not by treating an existing public store document as source.

Coordinator emission rule:

- `WorkbenchThreadClient.state.currentThread` is the final visible thread emitted in the thread-client snapshot.
- `WorkbenchClient.ts` copies that projected thread into `SessionState.currentThread` only through `applyCurrentThreadSelection`, and then emits via `emitCurrentThreadChange`.
- Both comparator/emission paths must be projection-aware. A stable public store snapshot is not enough if `SessionState.currentThread` still churns a turbo turn, and a stable `currentThread` is not enough if `threadDocuments` still emits a rebuilt giant snapshot.

Public snapshot container-sharing rule:

- Preserve the previous snapshot object when the selected key, key map, and materialized final visible document references are unchanged.
- Preserve key/order containers when no document was added, removed, re-keyed, or reordered.
- Preserve document map/container references when all contained final visible document references are unchanged.
- Do not deep-compare turns/items to decide snapshot emission; public snapshot emission must be driven by selected key, key/container identity, and final visible document references/revisions.

## Live Reconciliation Source Sequencing

`mergeLiveStreamingThreadSnapshot` currently reads `state.currentThread` as the live comparison source. If `state.currentThread` becomes projected, this can feed synthetic overlay items into live reconciliation.

Mandatory construction rule:

1. The replacement must introduce a separate live-safe source for reconciliation before any projected `state.currentThread` value can be used publicly.
2. `mergeLiveStreamingThreadSnapshot` must read from that live-safe source, not from projected `state.currentThread`.
3. The live-safe source must exclude Workbench synthetic questionnaire, steer, screenshot, and optimistic overlay items unless a specific live reconciliation path intentionally handles optimistic user messages.
4. `state.currentThread` becomes a projected visible state only in the same coherent replacement where `mergeLiveStreamingThreadSnapshot` is detached from it.

Existing projected documents in `ThreadDocumentStore` are potentially polluted with synthetic overlay items. The replacement must not treat existing store entries as canonical source unless they are passed through a deprojection/normalization step that strips Workbench synthetic overlay items.

Required live source state:

- live source revision for the whole thread document key,
- per-turn live source revisions for affected turn keys,
- client-created streaming item keys,
- replacement mappings between client-created/live placeholders and canonical completed items,
- active live placeholder IDs/kinds by turn,
- completed item snapshots waiting for canonical replacement,
- turn metadata needed by live reconciliation,
- disposal markers for turns whose live state has been resolved.

Live source disposal rules:

- Clear live source state for a thread when the thread document key is cleared or removed.
- Clear selected-only live comparison state when selection changes away from a thread unless an active background live stream still owns that state.
- Clear per-turn live placeholders and replacement mappings when canonical replacement succeeds and no unresolved live placeholder remains for that turn.
- Clear or mark inactive live state on stop/pause when the bridge reports the run is no longer streaming.
- Do not dispose client-created key state before the canonical replacement path has either matched it or explicitly abandoned it.

Optimistic user messages are excluded from live reconciliation by default. If a future path intentionally reconciles optimistic user messages with live/canonical messages, that path must be named in the source plan and must prove it does not expose Workbench synthetic questionnaire, steer, or screenshot items to live reconciliation.

## Status And Summary Ownership

Waiting-on-user-input and thread status are Workbench overlay sources for visible thread payloads, but they also affect thread summaries. The status source is the single authority for both outputs.

- `writeStatusSource` updates the status/waiting source record and bumps its revision only when the visible value changed.
- The Workbench overlay layer reads that source to produce complete visible thread status.
- The summary updater reads the same status source change; it must not infer summary status by mutating or re-reading a projected `ThreadPayload` as source.
- A projection flush may briefly be pending after a status source write, but public pending-input lookups must read the latest final visible projection or the status source authority, not stale projected payloads.

Summary field ownership:

- Canonical read/hydration inputs own canonical summary facts such as thread ID, harness, title, creation/update metadata, and durable completion state when those values come from the service.
- Stable preference source owns fallback summary-facing model, reasoning effort, service tier, agent, and token usage values when canonical payloads do not provide real values.
- Status source owns waiting-on-user-input and visible status repairs.
- Final visible projection may be used as a read model for UI display, but summary writers must not mutate projected payloads and then store them as source.
- Any source implementation plan must map current summary update paths into one of these owners before source edits begin.

Status provenance rule:

- Canonical service status must be recorded as canonical input provenance when it arrives from raw app-server/hydration data.
- Overlay status/waiting repairs must be recorded as Workbench status source provenance.
- Deprojection may strip status/waiting fields only when provenance proves they came from Workbench overlay state. If provenance is unknown, deprojection must preserve the field or stop for a source-plan decision; it must not guess.
- Pending-input lookup precedence must be explicit in source implementation: read final visible projection when current, otherwise read the status source authority for the selected/resolved key. Do not race two unrelated answers.

## Existing Projected Store Entry Handling

On replacement initialization, existing public `ThreadDocumentStore` entries must not become canonical source by default because they may contain Workbench synthetic overlay items.

Allowed startup options:

1. Ignore existing projected public store entries as source and wait for canonical reads/hydration to populate canonical inputs.
2. Pass an existing projected store entry through a named deprojection function that strips all Workbench synthetic item kinds and top-level overlay-only fields before canonical ingestion.

Prefer ignoring existing projected public store entries as source for turbo-turn validation unless a concrete startup/resume requirement needs deprojection.

The deprojection function, if implemented, must not run live streaming duplicate pruning, `normalizeStreamingText`, questionnaire overlay projection, steer overlay projection, optimistic overlay projection, or status projection. It is a boundary cleanup step only.

Required deprojection stripping rules:

- Strip items detected by `isSyntheticQuestionnaireHistoryItem`.
- Strip items detected by `isSyntheticSteerHistoryItem`.
- Strip Workbench-only steer user messages detected by `isWorkbenchSyntheticSteerUserMessage`.
- Strip optimistic user-message items, including IDs with the `optimistic-user-message:` prefix; if the optimistic guard is not currently exported, the replacement must expose an owned guard before deprojection uses it.
- Strip top-level `browseScreenshotEntries` because screenshot entries are overlay metadata.
- Strip visible-only waiting/status overlay fields only when status provenance proves they were not present in canonical service data.
- Preserve canonical item ordering, canonical item IDs, turn ordering, and turn IDs for all surviving items/turns.

## Lifecycle Function Target Names

The replacement should introduce lifecycle names like these in `WorkbenchThreadClient` and the layer controllers, so future agents do not freestyle the lifecycle:

- `buildCanonicalThread(rawCanonicalInput)`
- `reconcileLiveThread(canonicalThread, liveSources)`
- `applyWorkbenchThreadOverlays(liveThread, overlaySources)`
- `stabilizeFinalVisibleThread(overlayThread, publicMaterializationState)`
- `materializeFinalVisibleThread(threadKey, options)`
- `invalidateThreadProjection(threadKey, reason)`
- `flushThreadProjection(threadKey)`

Avoid adding new generic booleans such as `skipPrune` or `applyOverlays`. Prefer named functions that encode the lifecycle responsibility.

## Complete Thread Pipeline Flush Pseudocode

The replacement does not need a perfect generalized projection framework. It does need a selected-thread and materialized-document path whose render pipeline is visibly complete-thread-in, complete-thread-out.

```ts
function invalidateThreadRendering(key: ThreadDocumentKey, reason: ThreadRenderInvalidationReason) {
  dirtyThreadRenderKeys.add(key);
  renderDirtyThread(key, reason);
}

function flushSelectedThreadRendering(reason: ThreadRenderInvalidationReason) {
  const key = selectedThreadKey;
  if (!key) {
    setProjectedCurrentThread(null);
    syncProjectedStoreSelection("");
    return;
  }

  const finalVisibleThread = materializeFinalVisibleThread(key, {
    select: true,
    reason,
  });

  if (!finalVisibleThread) {
    setProjectedCurrentThread(null);
    return;
  }

  setProjectedCurrentThread(finalVisibleThread);
}
```

`setProjectedCurrentThread` is the only operation that should assign `state.currentThread` after the projection split. Its input is always a complete final visible thread object from `materializeFinalVisibleThread`. It may mark unread state as seen, emit changes, and schedule rate-limit refreshes, but it must not run canonical normalization, Workbench overlay projection, or streaming duplicate pruning.

## Complete Thread Pipeline Function Pseudocode

Each layer tests its own dependencies before doing work. The pipeline itself should read like complete thread object to complete thread object.

```ts
function materializeFinalVisibleThread(
  key: ThreadDocumentKey,
  options: ThreadMaterializationOptions,
): ThreadPayload | null {
  const rawCanonicalInput = canonicalInputs.get(key);
  if (!rawCanonicalInput) return null;

  const canonicalThread = canonicalLayer.render(rawCanonicalInput);
  const liveThread = liveLayer.render(canonicalThread, liveSources.get(key));
  const overlayThread = overlayLayer.render(liveThread, overlaySources.get(key));
  const finalVisibleThread = visibleLayer.render(overlayThread, {
    selected: selectedThreadKey === key,
    materializationReason: options.reason,
  });

  threadDocumentStore.materializeFinalVisibleDocument(key, finalVisibleThread, options);
  return finalVisibleThread;
}
```

`threadDocumentStore.materializeFinalVisibleDocument(...)` is the concrete public snapshot-layer operation in this pseudocode. When implementing this for real, each `.render(...)` call must be backed by an explicit layer cache entry. Do not use object-spread cloning between every line unless that layer changed something. Do not hide previous-layer logic inside later-layer `.render(...)` calls.

## Coherent Replacement Implementation Contract

The implementation is a single coherent replacement, not a phased runtime migration. The work can be coded in a careful internal order, but the approved behavior change should land with all source/projection boundaries present at once.

### Replacement files

Expected source files for the coherent replacement:

- `webapp/lib/WorkbenchClient.ts`
- `webapp/lib/workbench/WorkbenchThreadClient.ts`
- `webapp/lib/workbench/state/ThreadDocumentStore.ts`
- `webapp/lib/workbench/thread/ThreadRenderPipeline.ts`
- `webapp/lib/workbench/thread/ThreadCanonicalLayer.ts`
- `webapp/lib/workbench/thread/ThreadStreamingReconciler.ts`
- `webapp/lib/workbench/thread/ThreadWorkbenchOverlayLayer.ts`
- `webapp/lib/workbench/thread/ThreadVisibleLayer.ts`
- `webapp/lib/workbench/thread/ThreadDeprojectionBoundary.ts` if the replacement chooses to seed canonical inputs from existing projected public store entries instead of ignoring those entries as source.

The layer files are mandatory replacement owners. They should be prominent controllers with matching PascalCase filenames and default exports. `ThreadRenderPipeline.ts` may coordinate the ordered complete-thread pipeline, but it must not absorb the ownership of canonical normalization, live reconciliation, Workbench overlays, or final visible snapshot emission.

### Internal implementation order inside the replacement

1. Add layer input orchestration in `WorkbenchThreadClient`: canonical raw inputs, live source records/revisions, overlay source records/revisions, stable preference/status source records/revisions, and selected key. Each layer controller owns its own cache; `WorkbenchThreadClient` must not centralize layer cache internals.
2. Add `ThreadCanonicalLayer` as the complete raw-canonical-input -> complete canonical renderable thread transform.
3. Add `ThreadStreamingReconciler` as the complete canonical thread -> complete live-reconciled renderable thread transform and as the only owner of client-created streaming item keys, replacement-key cleanup, live placeholder/canonical replacement, `normalizeStreamingText`, structural streaming compatibility, context-compaction lifecycle repair, `mergeWorkbenchThreadTurnBodies`, `mergeLiveStreamingTurn`, and duplicate streaming pruning.
4. Add `ThreadWorkbenchOverlayLayer` as the complete live-reconciled thread -> complete Workbench-overlay renderable thread transform and as the owner of questionnaire, steer, screenshot, optimistic, stable preference, and visible status projection.
5. Add `ThreadVisibleLayer` and `ThreadRenderPipeline` as the complete Workbench-overlay thread -> complete final visible thread -> public materialization path.
6. Add `ThreadDeprojectionBoundary` only if existing projected store entries must seed canonical inputs. If startup ignores public store entries as source, this file is unnecessary.
7. Replace `normalizeThreadDocument` callers with layer input writes plus `materializeFinalVisibleThread`/projection flushes. Do not keep an all-in-one `normalizeThreadDocument` as an alternate path.
8. Replace completed-history reapply functions with overlay source writes and one overlay-layer invalidation.
9. Replace direct `state.currentThread = ...` mutations with final-visible materialization plus `setProjectedCurrentThread`.
10. Keep public `state.currentThread` and `threadDocuments.getSnapshot()` as final visible outputs for UI consumers.
11. Ensure every path that needs source data reads layer inputs and every path that needs UI-visible data reads final visible records.
12. Move all client-created streaming key and replacement-map mutations behind `ThreadStreamingReconciler` methods. Old paths such as `upsertThreadItem`, `updateTurnItems`, and `mergeLiveStreamingThreadSnapshot` may orchestrate calls, but they must not mutate live key/replacement state directly.

### Old mechanisms the replacement must remove

- No `reapplyCurrentThreadQuestionnaireHistory`, `reapplyCurrentThreadSteerHistory`, or `reapplyCurrentThreadBrowseScreenshotEntries` manual replay path.
- No completed-history path calls `pruneThreadStreamingDuplicates`.
- No live reconciliation reads from projected `state.currentThread`.
- No projected synthetic overlay item is stored as canonical source.
- No layer returns a partial fragment, mutation callback, patch list, or side-channel manager state as its primary rendered output.
- No generic lifecycle boolean such as `skipPrune` controls the replacement. Use owner methods with lifecycle-specific names.

### Public compatibility requirements

- Public `WorkbenchThreadDocumentSnapshot` keeps the same TypeScript shape.
- Public snapshot values remain visible/projected `ThreadPayload` values.
- `WorkbenchClient.ts` should avoid deep-emitting giant `threadDocuments` snapshots for overlay-only selected-thread changes when the projected snapshot did not change, and should evaluate `currentThread` emission separately from `threadDocuments` emission.
- Main thread view, subthreads, mosaic panels, and collaboration views must still receive projected visible documents.
- Pending user input lookup must use projected visible data, because pending user input is a visible UI contract and the public snapshot remains projected.

## Architecture Decisions

### Should `ThreadDocumentStore` store source documents or visible projections?

Decision: keep `ThreadDocumentStore` as the public projected document store. Add private layer input records inside the thread client and layer controllers for canonical, live-safe, overlay, preference, and status state. This preserves the existing UI snapshot contract while preventing projected synthetic overlay items from becoming input to canonical normalization or streaming reconciliation.

Risk to audit during implementation: source-owning paths must never read canonical data back from `ThreadDocumentStore`, because it remains projected/final-visible. Those paths must use private layer inputs, then run the complete-thread pipeline.

### Should live streaming reconciliation output be stored or derived?

Decision: cache reconciled live document state while a thread is active, because streaming reconciliation has lifecycle state such as client-created item keys and replacement decisions. Treat it as a layer above canonical reads but below Workbench overlays.

Risk to audit during implementation: if reconciliation output is cached too durably, stale live placeholders could survive canonical replacement. The reconciler needs explicit disposal or revision invalidation when the selected thread changes, a turn completes, or canonical snapshot replacement succeeds. The reconciler cache still stores a complete live-reconciled thread object; stale-placeholder cleanup cannot be represented only as a side table.

### Should Workbench overlays be projected on every store read or cached?

Decision: cache the complete Workbench-overlay thread by overlay revision and canonical/live output revisions. Recompute lazily for the selected thread and eagerly only when a caller needs a non-selected visible document.

Risk to audit during implementation: background thread list or collaboration surfaces might need final visible state for non-selected threads. Those call sites should continue reading public projected snapshots; source-only reads stay private to the replacement owners. Non-selected materialization must still run the same complete-thread pipeline.

## Proposed Internal Data Shapes

These names are planning names, not final API commitments. They make the intended ownership concrete enough that implementation should not freestyle the state model.

```ts
type ThreadDocumentKey = string;

interface CanonicalThreadInputRecord {
  key: ThreadDocumentKey;
  threadId: string;
  harness: WorkbenchHarness;
  rawThread: ThreadPayload;
  revision: number;
}

interface CompleteThreadLayerCacheEntry {
  key: ThreadDocumentKey;
  inputRevision: number;
  inputThread: ThreadPayload | null;
  outputRevision: number;
  outputThread: ThreadPayload;
}

interface CanonicalThreadLayerCacheEntry {
  key: ThreadDocumentKey;
  rawInputRevision: number;
  normalizationRevision: number;
  outputRevision: number;
  canonicalThread: ThreadPayload;
}

interface LiveThreadLayerCacheEntry {
  key: ThreadDocumentKey;
  canonicalOutputRevision: number;
  liveRevision: number;
  affectedTurnRevisions: ReadonlyMap<string, number>;
  outputRevision: number;
  liveThread: ThreadPayload;
}

interface WorkbenchOverlayLayerCacheEntry {
  key: ThreadDocumentKey;
  liveOutputRevision: number;
  questionnaireRevision: number;
  questionnaireForceProjectionEpoch: number;
  steerRevision: number;
  screenshotRevision: number;
  optimisticRevision: number;
  stablePreferenceRevision: number;
  statusRevision: number;
  producedSyntheticItemIdsByTurn: ReadonlyMap<string, ReadonlySet<string>>;
  outputRevision: number;
  overlayThread: ThreadPayload;
}

interface VisibleThreadLayerCacheEntry {
  key: ThreadDocumentKey;
  overlayOutputRevision: number;
  selectionRevision: number;
  publicMaterializationRevision: number;
  outputRevision: number;
  finalVisibleThread: ThreadPayload;
}

interface ThreadDocumentStoreSnapshotCacheEntry {
  selectedKey: ThreadDocumentKey | null;
  documentReferencesByKey: ReadonlyMap<ThreadDocumentKey, ThreadPayload>;
  outputRevision: number;
  snapshot: WorkbenchThreadDocumentSnapshot;
}

interface ThreadOverlaySourceRecord {
  key: ThreadDocumentKey;
  threadId: string;
  questionnaireRevision: number;
  questionnaireForceProjectionEpoch: number;
  questionnaireDirtyTurnIds: ReadonlySet<string>;
  steerRevision: number;
  steerDirtyTurnIds: ReadonlySet<string>;
  screenshotRevision: number;
  optimisticRevision: number;
  optimisticDirtyTurnKeys: ReadonlySet<string>;
}

interface ThreadStablePreferenceRecord {
  key: ThreadDocumentKey;
  stablePreferenceRevision: number;
  model: string | null;
  modelRevision: number;
  reasoningEffort: ThreadPayload["reasoningEffort"];
  reasoningRevision: number;
  serviceTier: ThreadPayload["serviceTier"];
  serviceTierRevision: number;
  agentPath: ThreadPayload["agentPath"];
  agentNickname: ThreadPayload["agentNickname"];
  agentRole: ThreadPayload["agentRole"];
  agentRevision: number;
  tokenUsage: ThreadPayload["tokenUsage"];
  tokenUsageRevision: number;
}

interface ThreadStatusRecord {
  key: ThreadDocumentKey;
  statusRevision: number;
  status: ThreadPayload["status"] | undefined;
  waitingOnUserInput: boolean;
}
```

Revision numbers are preferable to expensive structural comparisons. If an existing setter can already prove no change with `areDeeplyEqual`, it should avoid bumping the revision.

Stable preference precedence:

- Canonical payload values win when present.
- Stable preference values fill missing canonical values for model, reasoning effort, service tier, agent path, agent nickname, agent role, and token usage.
- Stable preferences must be updated from explicit user setters, draft/send selection, resumed thread metadata, and stored harness preferences. They must not be bootstrapped by reading projected `state.currentThread` after projection ownership is introduced.
- If a canonical read returns a real value for a field that was previously only stable preference fallback, projection may continue to render the same visible value while the source owner records that the canonical layer now owns it.

## Full Replacement Acceptance Criteria

The coherent replacement is acceptable only when all of these are true:

- Completed history refresh for browse screenshots, questionnaire history, and steer history performs at most one selected-thread projection flush.
- Every runtime layer accepts and returns a complete renderable `ThreadPayload`, except the public snapshot layer which accepts complete final visible `ThreadPayload` objects and returns `WorkbenchThreadDocumentSnapshot`.
- Every layer cache stores its complete output thread, not a fragment, patch list, mutation callback, or side-channel manager state.
- Completed history refresh does not call `pruneThreadStreamingDuplicates`.
- Completed history refresh does not call `pruneDuplicateStreamingItems`.
- Completed history refresh does not call `normalizeStreamingText`.
- Selected-thread materialization for a completed thread with no live state does not call `pruneThreadStreamingDuplicates`, `pruneDuplicateStreamingItems`, or `normalizeStreamingText`.
- First projection after startup/history refresh does not scan item text for unrelated huge completed turns.
- Equivalent canonical refresh of a completed turbo thread preserves unchanged turn/item identities and does not rerun whole-turn canonical normalization for unchanged turns.
- Repeated no-op `materializeFinalVisibleThread` calls preserve the `ThreadDocumentStore` snapshot object, key/order containers, document containers, selected document reference, `turns`, unaffected turn objects, unaffected `items`, and unaffected item objects.
- Screenshot-only changes preserve the visible thread's `turns` array reference.
- Screenshot-only changes intentionally emit visible metadata changes when the public projected thread changes.
- Overlay changes affecting one turn preserve all other visible turn object references.
- Unchanged canonical/live items preserve object identity through projection.
- Forced questionnaire replay preserves existing synthetic item reuse when equivalent entries are unchanged and must not recreate unrelated turn/item arrays.
- Existing questionnaire, steer, screenshot, optimistic user-message, waiting-on-user-input, subthread, mosaic, and collaboration behavior remains visible.
- Canonical reads and live streaming updates still reconcile partial/canonical duplicate streaming items.
- Public `currentThread` and `threadDocuments` snapshots are projected visible documents, not source records.
- Live reconciliation reads live-safe records, not projected documents.
- Synthetic overlay items are never written into canonical source records.
- Existing polluted public store entries are either ignored as source or deprojected by the named boundary cleanup function before canonical ingestion.

## Behavior Preservation Golden Cases

The replacement must preserve these behavior cases with focused fixtures, instrumentation, or source-level proof where automated fixtures are not practical:

- Questionnaire history inserts near the same anchor before and after context compaction, including delayed/missing anchor metadata.
- Deleted questionnaire and steer entries remove stale synthetic items without scanning unrelated huge turns.
- Moved questionnaire anchors and changed steer target turns dirty old target, new target, and previously produced synthetic turns.
- Questionnaire forced replay preserves the compaction duplicate-message fix without reprocessing unrelated turbo turns.
- Steer history deduplicates against canonical user messages and preserves expected synthetic user-message placement.
- Optimistic user messages appear while unresolved and disappear when canonical or synthetic equivalents exist, including when the equivalent appears in a different dirty or base-changed turn.
- Generic snapshot reasoning/context-compaction items repair against canonical owners without collapsing unrelated canonical reasoning IDs.
- State-change `<set-state ... />` items keep their special duplicate compatibility semantics.
- Browse screenshot entries remain top-level metadata and do not mutate `turns`.
- Waiting-on-user-input status remains visible to pending-input lookup and thread summaries without treating projected payloads as source.
- Subthread, mosaic, and collaboration readers receive final visible projected documents after non-selected materialization.
- Deprojection startup strips Workbench synthetic/overlay-only state without changing surviving canonical order or anchors.
- Same `threadId` under different `ThreadDocumentKey`/harness contexts does not cross-attach questionnaire, steer, screenshot, optimistic, status, or stable preference sources.
- Selection clear and missing-canonical-input paths update current thread, public selected-key mirror, dirty render keys, and subscribers coherently.

## Non-goals For The Coherent Replacement

- Do not optimize the duplicate-pruning candidate algorithm beyond moving it to the correct owner.
- Do not cache normalized streaming text.
- Do not change thread item rendering semantics. Small subscription, snapshot-emission, or consumer dependency changes are allowed when required to prevent whole-snapshot churn.
- Do not change transcript storage, hydration contracts, or generated Codex types.
- Do not change public `WorkbenchThreadDocumentSnapshot` shape.
- Do not intentionally change thread item ordering, overlay order, or canonical anchor semantics.

## Replacement Implementation Checklist

Before implementation, the source plan must map every current path below to a replacement owner. During implementation, none of these paths may keep manually pushing visible/projection payloads back into source state.

- `setCurrentThread`
- `upsertThreadDocument`
- `updateCurrentThread`
- `updateCurrentThreadFields`
- `mergeStableThreadMetadata`
- `mergeWorkbenchThreadTurnBodies`
- `forgetReplacedStreamingItem`
- `forgetStreamingItemKey`
- `fetchThreadPayload`
- `readCurrentThread`
- `readThread`
- `openThread`
- `selectThreadPayload`
- `reconcileCurrentThreadFromRead`
- `mergeLiveStreamingThreadSnapshot`
- `mergeLiveStreamingTurn`
- `upsertTurnMetadata`
- `updateTurnItems`
- `upsertThreadItem`
- `ensureTurnForStreamingDelta`
- `updateOrCreateThreadItem`
- `updateThreadItem`
- `readCompletedQuestionnaireHistory`
- `readCompletedSteerHistory`
- `readBrowseScreenshotEntries`
- `readCompletedThreadWorkbenchHistory`
- `recordLocalQuestionnaireHistoryEntry`
- `refreshCurrentThreadOptimisticUserMessages`
- `markThreadWaitingOnUserInput`
- `clearThreadWaitingOnUserInputFlag`
- `clearThreadSelection`
- `setCurrentThreadModel`
- `setCurrentThreadAgent`
- `setCurrentThreadReasoningEffort`
- `setCurrentThreadServiceTier`
- `setDraftThreadHarness`
- `clearThreadTokenUsage`
- `getPendingUserInputRequestThread`
- `SessionState.applyCurrentThreadSelection`
- `emitCurrentThreadChange`
- `ThreadDocumentStore.getSnapshot`
- `ThreadDocumentStore.upsertDocument`
- `ThreadDocumentStore.clear`
- `ThreadDocumentStore.selectDocumentKey`
- thread-summary update paths for canonical metadata, stable preferences, token usage, and status/waiting fields
- startup/hydration paths that might seed source records from existing `ThreadDocumentStore` entries
- `applyCodexNotificationToCurrentThread`
- `sendThreadMessage`
- `stopThread`
- `pauseThread`

## Implementation Guardrails For Future Agents

- Do not remove `normalizeStreamingText`.
- Do not change `canPruneDuplicateStreamingItems` semantics as part of the replacement. Moving ownership is allowed; changing duplicate-match semantics is not.
- Preserve the questionnaire forced replay behavior from `e0658fcb` through `questionnaireForceProjectionEpoch`, with validation proving projected overlays remain present after compaction.
- Do not store projected synthetic overlay items as canonical source items.
- Do not introduce a module-global cache of normalized giant strings.
- Do not deep-clone `ThreadPayload` turns/items to make equality easier.
- Do not use `JSON.stringify` for new equality checks.
- Do not implement a partial runtime migration where some callers use old visible payloads as source and other callers use new source records.
- Do not call local webapp endpoints for validation without explicit user permission.
- Do not run any `pnpm` script except `typecheck`.

## Validation Ideas

- Run `pnpm typecheck` from `webapp/` after the coherent replacement is implemented. The current `webapp/package.json` has no ordinary test script, and project guidance forbids running `pnpm` scripts other than `typecheck`.
- Run `git diff --check` from the repository root after the coherent replacement is implemented.
- Use browser/profile reproduction for a turbo turn only after explicit user approval for local browser/app verification.
- Add required deterministic instrumentation or assertions during validation to count `pruneThreadStreamingDuplicates`, `pruneDuplicateStreamingItems`, and `normalizeStreamingText` calls. Completed-history refresh and selected-thread materialization with no live state must record zero calls for all three while canonical reads and live streaming paths may still call them when their layer inputs prove live reconciliation is needed.
- Add required materialization counters per `ThreadDocumentKey`. A completed-history refresh that reads questionnaire, steer, and screenshot histories for the same key must produce one scheduled materialization for that key, not three.
- Add required key-collision fixtures with the same `threadId` under different harness/document keys. Overlay writes and materialization must affect only the resolved `ThreadDocumentKey`.
- Add required scheduler race fixtures: completed-history batch plus concurrent canonical refresh/live delta must produce a coherent final materialization order and no duplicate flush storm.
- Add required item-access or candidate-scan proof for a completed turbo turn with no live state. Use a sentinel/proxy/instrumented turn or focused counters around candidate scanning to prove live reconciliation does not read completed no-live turn `items`, and overlay projection does not scan unrelated huge turn item text.
- Add required first-projection validation after startup/history refresh with missing produced synthetic indexes. It must prove bounded synthetic cleanup and no full item-text scan of unrelated huge completed turns.
- Add required reference preservation assertions: screenshot-only updates preserve `currentThread.turns` and `threadDocuments.documentsByKey[key].turns`; one-turn overlay updates preserve other turn references; unchanged `items` arrays and item objects survive; public snapshot object/key containers/document containers are preserved when their entries are unchanged; repeated no-op materialization emits nothing.
- Add required emission counters for `currentThread` subscribers, `ThreadDocumentStore` subscribers, and `WorkbenchClient.ts` thread-document/current-thread emissions.
- Validate `WorkbenchClient.ts` current-thread emission and `threadDocuments` snapshot emission separately. A fix that stabilizes one but churns the other does not satisfy the replacement.
- Verify canonical thread reads and live streaming replacement still remove duplicate partial/canonical items. This must be checked through source review at minimum and through browser/profile reproduction when the user approves local verification.
- Validate non-selected materialization for subthread, mosaic, and collaboration readers so final visible documents are produced without treating public projected store entries as canonical source.
- Validate polluted public store entries are either ignored as source or stripped by the named deprojection function before canonical ingestion.
- Validate thread-summary updates for canonical summary facts, stable preference fallback fields, status/waiting fields, and token usage without mutating projected payloads as source.
- Validate selection clear, removed thread, failed canonical read, and missing canonical input paths for coherent current-thread/store/subscriber behavior.
- Validate status provenance when deprojection is implemented: canonical service status survives, overlay-only status is stripped, and unknown provenance does not get guessed away.
- Validate non-selected materialization scope with counters proving background refresh materializes only selected/displayed/collaboration-needed keys, not every known document.

## Adversarial Review Findings To Preserve

A fresh-context adversarial review identified these plan risks. The current plan resolves them by requiring a coherent replacement instead of a multi-step migration. Do not delete this section until each risk is resolved by implementation or superseded by a newer ADR/plan.

- A partial multi-phase runtime migration is unsafe; replacement must land with the source/projection boundary coherent.
- Public `threadDocuments` snapshots currently feed main thread view, subthreads, mosaic, and collaboration. Keep them projected/visible in the replacement.
- Overlay order is part of behavior. Questionnaire must run before steer and optimistic overlays because it strips Workbench synthetic steer messages.
- Forced questionnaire projection needs an explicit epoch or cache-bypass; use `questionnaireForceProjectionEpoch`.
- Live reconciliation must use a live-safe source record; projected `state.currentThread` must not be a live reconciliation input.
- Synthetic overlay item identity needs explicit reuse/cache rules.
- Existing store entries may already contain projected synthetic items; do not treat them as canonical source without stripping/deprojection.
- `WorkbenchClient.ts` deep-compares `threadDocuments` snapshots; avoiding unnecessary store snapshot emission is part of the perf target.
- `WorkbenchClient.ts` also emits selected `currentThread` separately; avoiding public store churn alone is not enough.
- Overlay dirty metadata must be turn-targeted for questionnaire and steer overlays, or the overlay layer can still scan huge turns to rediscover affected anchors.

## Current Known Risks

- `normalizeStreamingText` is needed for partial/canonical streaming reconciliation, so removing it would be unsafe.
- The questionnaire `entries.length` forced reapply was added by commit `e0658fcb` for duplicate agent messages after compaction; preserve that behavior through `questionnaireForceProjectionEpoch`.
- `ADR-0002` says canonical thread item anchors must be preserved. Any pruning or reconciliation refactor must not collapse unrelated canonical reasoning IDs just because text matches.
- The current `WorkbenchThreadClient` is already a broad owner. The replacement should name seams clearly and extract layer controllers without creating helper soup.
